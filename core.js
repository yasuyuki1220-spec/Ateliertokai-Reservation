/* 予約システムの中身（画面なし）。お客様画面・管理画面の両方から使う。 */
(function (root) {
'use strict';
var STORES = { '鹿児島東開': ['小園','原田','寺床','植木','日髙','濱崎','下石原','坂口','西','新田','不明'], 'CPO川内': ['瀬戸口','石野','小川','不明'] };
var ALPH = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
var LAP_TEXT = 'お席に限りが御座います。未就学児のお子様は保護者のお膝の上でよろしければ人数に含まなくても結構です。';

function makeCore(firebase, db, opts) {
  opts = opts || {};
  var cr = opts.crypto || root.crypto;
  var now = opts.now || function () { return Date.now(); };
  var sleep = opts.sleep || function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };
  var FV = firebase.firestore.FieldValue;
  var events = db.collection('events'), slots = db.collection('slots'), res = db.collection('reservations'), apps = db.collection('applicants');

  var fail = function (m) { return { ok: false, msg: m }; };
  var ok = function (x) { var o = { ok: true }; for (var k in (x || {})) o[k] = x[k]; return o; };
  var normMail = function (s) { return String(s || '').trim().toLowerCase(); };
  var isFixed = function (st) { return st === 'confirmed' || st === 'won'; };
  var ms = function (t) { return t ? (t.toMillis ? t.toMillis() : (t.__ts || 0)) : 0; };

  function rnd(n) { var a = new Uint32Array(1); cr.getRandomValues(a); return a[0] % n; }
  function newId() { var s = ''; for (var i = 0; i < 12; i++) s += ALPH[rnd(32)]; return s; }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = rnd(i + 1), t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  async function sha(str) {
    var b = await cr.subtle.digest('SHA-256', new TextEncoder().encode(str));
    return Array.prototype.map.call(new Uint8Array(b), function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
  }
  // 同じイベント（同一イベントグループ）には、同じメールアドレスで1回だけ申し込める
  function appKey(ev, eventId, mail) { return sha((ev && ev.group ? 'g:' + ev.group : 'e:' + eventId) + '|' + normMail(mail)); }

  async function withRetry(fn, onRetry) {
    for (var i = 0; i < 10; i++) {
      try { return await fn(); }
      catch (e) {
        var c = e && e.code;
        if (c === 'aborted' || c === 'resource-exhausted' || /contention|too much|aborted/i.test(String(e && e.message))) {
          if (onRetry) onRetry(i + 1);
          await sleep(200 + Math.random() * 900 + i * 150);
          continue;
        }
        throw e;
      }
    }
    return fail('混み合っていて処理できませんでした。少し待ってもう一度お試しください');
  }

  var fits = function (s, n, extraGroups) { return (s.booked || 0) + (extraGroups || 1) <= s.capG && (!s.capP || (s.people || 0) + n <= s.capP); };

  /* ---------- お客様: 申し込み ---------- */
  async function book(slotId, d) {
    var id = newId();
    d = Object.assign({}, d, { mail: normMail(d.mail) });
    return withRetry(function () {
      return db.runTransaction(async function (tx) {
        var sRef = slots.doc(slotId), sS = await tx.get(sRef);
        if (!sS.exists) return fail('この枠は削除されました');
        var s = sS.data(), eS = await tx.get(events.doc(s.eventId));
        if (!eS.exists) return fail('このイベントは削除されました');
        var ev = eS.data();
        if (!ev.visible) return fail('このイベントは受付を終了しました');
        var lot = ev.method === '抽選';
        if (lot) {
          if (ev.drawn) return fail('抽選は終了したため、新しいお申し込みはできません');
          if (ev.deadlineMs && now() > ev.deadlineMs) return fail('申込の受付は締め切りました');
        }
        var n = (+d.a || 0) + (+d.k || 0) + (+d.s || 0) + (+d.m || 0);
        if (n < 1 || n > s.maxPer) return fail('人数は1〜' + s.maxPer + '名で入力してください');
        var ak = await appKey(ev, s.eventId, d.mail), aRef = apps.doc(ak), aS = await tx.get(aRef);
        if (aS.exists) return fail('このメールアドレスは、すでにこのイベントにお申し込み済みです。内容の変更・キャンセルは「予約の確認・変更」から行えます');
        var status, upd = null, waitNo = 0;
        if (lot) status = 'lottery';
        else if (fits(s, n)) { status = 'confirmed'; upd = { booked: (s.booked || 0) + 1, people: (s.people || 0) + n }; }
        else if (ev.wait) { status = 'wait'; waitNo = (s.waitSeq || 0) + 1; upd = { waitSeq: waitNo }; }
        else return fail('この枠は満席です');
        var doc = Object.assign({}, d, { n: n, eventId: s.eventId, eventName: ev.name, slotId: slotId, date: s.date, start: s.start, end: s.end,
          status: status, waitNo: waitNo, fav: false, createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() });
        tx.set(res.doc(id), doc);
        tx.set(aRef, { resId: id, at: now() });
        if (upd) tx.update(sRef, upd);
        return ok({ id: id, status: status, waitNo: waitNo });
      });
    });
  }

  async function lookup(id, mail) {
    id = String(id || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-HJ-NP-Z2-9]{12}$/.test(id)) return fail('予約番号の形式が正しくありません');
    var s = await res.doc(id).get();
    if (!s.exists || s.data().mail !== normMail(mail)) return fail('予約番号またはメールアドレスが違います');
    return ok({ id: id, r: s.data() });
  }

  /* ---------- キャンセル（お客様・管理者） ---------- */
  async function cancel(id, mail, admin) {
    return withRetry(function () {
      return db.runTransaction(async function (tx) {
        var rRef = res.doc(id), rS = await tx.get(rRef);
        if (!rS.exists) return fail('予約が見つかりません');
        var r = rS.data();
        if (!admin && r.mail !== normMail(mail)) return fail('予約番号またはメールアドレスが違います');
        if (r.status === 'cancel') return fail('すでにキャンセル済みです');
        var sRef = slots.doc(r.slotId), sS = await tx.get(sRef), eS = await tx.get(events.doc(r.eventId));
        var ak = await appKey(eS.exists ? eS.data() : null, r.eventId, r.mail);
        tx.update(rRef, { status: 'cancel', updatedAt: FV.serverTimestamp() });
        var freed = false;
        if (sS.exists && isFixed(r.status)) {
          var s = sS.data(); freed = true;
          tx.update(sRef, { booked: Math.max(0, (s.booked || 0) - 1), people: Math.max(0, (s.people || 0) - r.n) });
        }
        tx.delete(apps.doc(ak));
        return ok({ freed: freed, slotId: r.slotId });
      });
    });
  }

  /* ---------- お客様: 内容の変更（人数・名前・連絡先・時間帯） ---------- */
  var EDIT = ['name', 'corp', 'tel', 'a', 'k', 's', 'm', 'participants', 'note', 'car', 'order', 'stores', 'staff'];
  async function change(id, mail, patch, newSlotId) {
    return withRetry(function () {
      return db.runTransaction(async function (tx) {
        var rRef = res.doc(id), rS = await tx.get(rRef);
        if (!rS.exists) return fail('予約が見つかりません');
        var r = rS.data();
        if (r.mail !== normMail(mail)) return fail('予約番号またはメールアドレスが違います');
        if (r.status === 'cancel') return fail('キャンセル済みの予約は変更できません');
        var oldRef = slots.doc(r.slotId), oldS = await tx.get(oldRef);
        var moving = newSlotId && newSlotId !== r.slotId, newRef = null, newS = null;
        if (moving) { newRef = slots.doc(newSlotId); newS = await tx.get(newRef); }
        var eS = await tx.get(events.doc(r.eventId)), ev = eS.exists ? eS.data() : {};
        var upd = {};
        EDIT.forEach(function (k) { if (patch && patch[k] !== undefined) upd[k] = patch[k]; });
        var m2 = Object.assign({}, r, upd);
        var n = (+m2.a || 0) + (+m2.k || 0) + (+m2.s || 0) + (+m2.m || 0);
        upd.n = n;
        var target = moving ? newS : oldS;
        if (!target.exists) return fail('この枠は削除されました');
        var t = target.data();
        if (n < 1 || n > t.maxPer) return fail('人数は1〜' + t.maxPer + '名で入力してください');
        if (moving) {
          if (t.eventId !== r.eventId) return fail('別のイベントの枠には変更できません');
          if (r.status === 'wait') return fail('キャンセル待ちの方は時間帯を変更できません。いったんキャンセルして申し込み直してください');
          if (ev.method === '抽選' && ev.drawn) return fail('抽選後は時間帯を変更できません');
          if (isFixed(r.status) && !fits(t, n)) return fail('変更先の枠は満席です');
          if (isFixed(r.status)) {
            var o = oldS.data();
            tx.update(oldRef, { booked: Math.max(0, (o.booked || 0) - 1), people: Math.max(0, (o.people || 0) - r.n) });
            tx.update(newRef, { booked: (t.booked || 0) + 1, people: (t.people || 0) + n });
          }
          Object.assign(upd, { slotId: newSlotId, date: t.date, start: t.start, end: t.end });
        } else if (isFixed(r.status) && n !== r.n) {
          if (t.capP && (t.people || 0) - r.n + n > t.capP) return fail('この枠の定員人数を超えるため、人数を増やせません');
          tx.update(oldRef, { people: Math.max(0, (t.people || 0) - r.n + n) });
        }
        upd.updatedAt = FV.serverTimestamp();
        tx.update(rRef, upd);
        return ok({});
      });
    });
  }

  /* ---------- 管理者 ---------- */
  async function promote(id) {
    return withRetry(function () {
      return db.runTransaction(async function (tx) {
        var rRef = res.doc(id), rS = await tx.get(rRef);
        if (!rS.exists) return fail('予約が見つかりません');
        var r = rS.data();
        if (r.status !== 'wait') return fail('キャンセル待ちの予約ではありません');
        var sRef = slots.doc(r.slotId), sS = await tx.get(sRef), s = sS.data();
        if (!fits(s, r.n)) return fail('この枠にはまだ空きがありません');
        tx.update(rRef, { status: 'confirmed', waitNo: 0, updatedAt: FV.serverTimestamp() });
        tx.update(sRef, { booked: (s.booked || 0) + 1, people: (s.people || 0) + r.n });
        return ok({});
      });
    });
  }

  async function chunked(ops) {
    for (var i = 0; i < ops.length; i += 400) {
      var b = db.batch();
      ops.slice(i, i + 400).forEach(function (o) { o(b); });
      await b.commit();
    }
  }

  // 抽選: 枠ごとに「忖度(fav)」を先に当選させ、残りは無作為。外れた方は申込順でキャンセル待ち（なしの設定なら落選）
  async function runLottery(eventId) {
    var eS = await events.doc(eventId).get();
    if (!eS.exists) return fail('イベントが見つかりません');
    var ev = eS.data();
    if (ev.method !== '抽選') return fail('抽選のイベントではありません');
    if (ev.drawn) return fail('すでに抽選済みです');
    var rs = await res.where('eventId', '==', eventId).where('status', '==', 'lottery').get();
    var ss = await slots.where('eventId', '==', eventId).get();
    var bySlot = {};
    rs.docs.forEach(function (d) { var r = d.data(); (bySlot[r.slotId] = bySlot[r.slotId] || []).push({ id: d.id, r: r }); });
    var ops = [], win = 0, wait = 0, lost = 0;
    ss.docs.forEach(function (sd) {
      var s = sd.data(), list = bySlot[sd.id] || [];
      var favs = shuffle(list.filter(function (x) { return x.r.fav; })), rest = shuffle(list.filter(function (x) { return !x.r.fav; }));
      var booked = s.booked || 0, people = s.people || 0, seq = s.waitSeq || 0, over = [];
      favs.concat(rest).forEach(function (x) {
        if (booked + 1 <= s.capG && (!s.capP || people + x.r.n <= s.capP)) {
          booked++; people += x.r.n; win++;
          ops.push(function (b) { b.update(res.doc(x.id), { status: 'won', updatedAt: FV.serverTimestamp() }); });
        } else over.push(x);
      });
      over.sort(function (p, q) { return ms(p.r.createdAt) - ms(q.r.createdAt); });
      over.forEach(function (x) {
        if (ev.wait) { seq++; wait++; ops.push(function (b) { b.update(res.doc(x.id), { status: 'wait', waitNo: seq, updatedAt: FV.serverTimestamp() }); }); }
        else { lost++; ops.push(function (b) { b.update(res.doc(x.id), { status: 'lost', updatedAt: FV.serverTimestamp() }); }); }
      });
      if (list.length) ops.push(function (b) { b.update(slots.doc(sd.id), { booked: booked, people: people, waitSeq: seq }); });
    });
    ops.push(function (b) { b.update(events.doc(eventId), { drawn: true }); });
    await chunked(ops);
    return ok({ win: win, wait: wait, lost: lost });
  }

  // 人数の数え直し（予約一覧から枠のカウンターを作り直す）
  async function recount(eventId) {
    var rs = await res.where('eventId', '==', eventId).get();
    var ss = await slots.where('eventId', '==', eventId).get();
    var c = {};
    rs.docs.forEach(function (d) {
      var r = d.data(), x = c[r.slotId] = c[r.slotId] || { booked: 0, people: 0, waitSeq: 0 };
      if (isFixed(r.status)) { x.booked++; x.people += r.n; }
      if (r.status === 'wait') x.waitSeq = Math.max(x.waitSeq, r.waitNo || 0);
    });
    var ops = ss.docs.map(function (sd) {
      var x = c[sd.id] || { booked: 0, people: 0, waitSeq: 0 };
      return function (b) { b.update(slots.doc(sd.id), x); };
    });
    await chunked(ops);
    return ok({ slots: ops.length });
  }

  // 時間枠の作成。minutes ごとに区切り、休憩時間は除く。allday なら終日1枠
  function makeTimes(o) {
    if (o.allday) return [['00:00', '24:00']];
    var toM = function (t) { var p = t.split(':'); return +p[0] * 60 + +p[1]; };
    var fmt = function (m) { return ('0' + Math.floor(m / 60)).slice(-2) + ':' + ('0' + (m % 60)).slice(-2); };
    var a = toM(o.start), z = toM(o.end), len = +o.minutes, out = [];
    var bs = o.bstart ? toM(o.bstart) : null, be = o.bend ? toM(o.bend) : null;
    for (var t = a; t + len <= z; ) {
      if (bs !== null && be !== null && t < be && t + len > bs) { t = be; continue; }
      out.push([fmt(t), fmt(t + len)]); t += len;
    }
    return out;
  }
  async function createSlots(eventId, ev, dates, o) {
    var times = makeTimes(o), ops = [];
    if (!times.length) return fail('枠が作れません。時刻を確認してください');
    ops.push(function (b) { b.set(events.doc(eventId), ev, { merge: true }); });
    dates.forEach(function (date) {
      times.forEach(function (t) {
        var sid = newId();
        ops.push(function (b) { b.set(slots.doc(sid), { eventId: eventId, eventName: ev.name, date: date, start: t[0], end: t[1], capG: +o.capG, capP: +o.capP || 0, maxPer: +o.maxPer || 4, booked: 0, people: 0, waitSeq: 0 }); });
      });
    });
    await chunked(ops);
    return ok({ count: dates.length * times.length });
  }

  async function deleteEvent(eventId) {
    var ss = await slots.where('eventId', '==', eventId).get();
    var ops = ss.docs.map(function (d) { return function (b) { b.delete(slots.doc(d.id)); }; });
    ops.push(function (b) { b.delete(events.doc(eventId)); });
    await chunked(ops);
    return ok({});
  }

  return { book: book, lookup: lookup, cancel: cancel, change: change, promote: promote, runLottery: runLottery, recount: recount,
    createSlots: createSlots, makeTimes: makeTimes, deleteEvent: deleteEvent, newId: newId, normMail: normMail, isFixed: isFixed, ms: ms,
    events: events, slots: slots, res: res, apps: apps };
}
root.makeCore = makeCore;
root.RV = { STORES: STORES, LAP_TEXT: LAP_TEXT };
if (typeof module !== 'undefined') module.exports = { makeCore: makeCore, RV: root.RV };
})(typeof window !== 'undefined' ? window : globalThis);
