#!/usr/bin/env node
/* ============================================================
   ANALISIS BUY/SELL — aturan grid breakout aiterminaltrading vs sinyal engine ini
   -------------------------------------------------------------
   Referensi: pitoyict13-droid/aiterminaltrading, mt5_grid_hft.py :: signal_for_pair().
   Repo itu TIDAK berlisensi (license: null), jadi tidak ada satu baris pun yang disalin —
   aturannya ditulis ulang dari deskripsi:
     · grid 15 pips (sel harga tetap), index = floor(harga / langkah)
     · index berpindah ke atas → LONG, ke bawah → SHORT
     · harus tertahan CONFIRM scan berturut-turut pada sel baru (anti-kedip)
     · EMA(M1) harus searah
     · hanya 07:00–19:00, dan ada blackout di sekitar rilis berita
   Geometrinya keluar dari ujian ini: alat ini hanya menimbang ARAH, seperti
   tools/signal_test.js — supaya "siapa yang benar soal buy/sell" tidak tercampur
   dengan "siapa yang benar soal TP/SL" (itu tools/_ait_geom.js).

   Penilaian: return maju H menit, dinormakan ATR(M15), didetrend, lalu diuji dengan
   stationary block bootstrap (politis–romano, blok rata-rata L). TRAIN/TEST dipotong
   di waktu, dan keduanya dilaporkan.

   Pemakaian: node tools/_ait_dir.js [EURUSD GBPUSD USDJPY XAUUSD] [--grid-pips=15]
            [--horizon=15] [--stride=15] [--split=0.6] [--confirm=2] [--ema=20]
            [--session=on|off] [--news=on|off] [--boot=2000] [--blocklen=10] [--seed=7]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const SPLIT = Number(opt('split', .6));
const H = Number(opt('horizon', 15)) * 60000;
const STRIDE = Number(opt('stride', Number(opt('horizon', 15)))) * 60000;
const GRID_PIPS = Number(opt('grid-pips', 15));
const CONFIRM = Number(opt('confirm', 2));
const EMAN = Number(opt('ema', 20));
const SESSION = opt('session', 'on') !== 'off';
const NEWS = opt('news', 'on') !== 'off';
const BOOT = Number(opt('boot', 2000));
const BL = Number(opt('blocklen', 10));
const SEED = Number(opt('seed', 7));
const EVAL = Number(opt('eval', 60000));
const MODE = opt('mode', 'balanced');
const LIST = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
const PAIRS = LIST.length ? LIST : ['EURUSD', 'GBPUSD', 'USDJPY', 'XAUUSD'];

function load(pair) {
  const cands = [path.join(__dirname, '../data', pair + '_1m.csv'),
    E.PAIRS[pair].binance && path.join(__dirname, '../data', String(E.PAIRS[pair].binance).toUpperCase() + '_1m.csv')
  ].filter(Boolean);
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    const rows = [];
    for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
      const c = line.split(','); if (c.length < 3) continue;
      const t = Number(c[0]), b = Number(c[1]), a = Number(c[2]);
      if (t && b > 0 && a >= b) rows.push([t, b, a]);
    }
    if (rows.length >= 1000) return { file: f, rows };
  }
  return null;
}

/* bar dari tick (mid) — 1m untuk EMA, 15m untuk ATR */
function bars(rows, min) {
  const out = []; let cur = null, key = -1;
  for (const [t, b, a] of rows) {
    const k = Math.floor(t / (min * 60000)), mid = (a + b) / 2;
    if (k !== key) { if (cur) out.push(cur); key = k; cur = { t: k * min * 60000, o: mid, h: mid, l: mid, c: mid }; }
    else { if (mid > cur.h) cur.h = mid; if (mid < cur.l) cur.l = mid; cur.c = mid; }
  }
  if (cur) out.push(cur);
  return out;
}
function emaOf(bs, n) { const k = 2 / (n + 1); let e = null; return bs.map(b => (e = e == null ? b.c : b.c * k + e * (1 - k))); }
function atrOf(bs, n) { const out = []; let a = null; for (let i = 0; i < bs.length; i++) { const p = bs[i - 1]; const tr = !p ? bs[i].h - bs[i].l : Math.max(bs[i].h - p.c, bs[i].l - p.c, bs[i].h - bs[i].l); if (i < n) { out.push(null); if (i === n - 1) { let s = 0; for (let j = 1; j <= n - 1; j++) { const q = bs[j - 1]; s += Math.max(bs[j].h - q.c, bs[j].l - q.c, bs[j].h - bs[j].l); } a = ((bs[0].h - bs[0].l) + s) / n; out[i] = a; } continue; } a = (a * (n - 1) + tr) / n; out.push(a); } return out; }
/* index bar yang SUDAH selesai pada waktu t (yang sedang berjalan dibuang: tanpa itu EMA/ATR mengintip masa depan) */
function doneIdx(stamps, t) { let lo = 0, hi = stamps.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (stamps[m] <= t) { r = m; lo = m + 1 } else hi = m - 1 } return r - 1; }
function idxAt(TS, t) { let lo = 0, hi = TS.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (TS[m] <= t) { r = m; lo = m + 1 } else hi = m - 1 } return r; }
const minUTC = t => new Date(t).getUTCHours() * 60 + new Date(t).getUTCMinutes();
const inNews = t => { const m = minUTC(t); return E.PARAMS.NEWS_BLACKOUT.some(([a, b]) => m >= a && m < b); };

/* ---------- aturan grid mereka ---------- */
function gridSignals(rows, pip, b1, b1t, ema, step) {
  const out = [];
  let committed = null, pend = null, cnt = 0;
  for (let i = 0; i < rows.length; i++) {
    const [t, bd, ak] = rows[i], mid = (bd + ak) / 2, ix = Math.floor(mid / step);
    if (committed == null) { committed = ix; continue; }
    if (ix === committed) { pend = null; cnt = 0; continue; }
    if (ix === pend) cnt++; else { pend = ix; cnt = 1; }
    if (cnt < CONFIRM) continue;
    const dir = ix > committed ? 1 : -1;
    committed = ix; pend = null; cnt = 0;
    if (SESSION) { const h = new Date(t).getUTCHours(); const fri = new Date(t).getUTCDay() === 5; if (h < 7 || h >= (fri ? 16 : 19)) continue; }
    if (NEWS && inNews(t)) continue;
    const j = doneIdx(b1t, t);
    if (j < 0 || ema[j] == null) continue;
    const agree = dir > 0 ? b1[j].c >= ema[j] : b1[j].c <= ema[j];
    if (!agree) continue;
    out.push({ t, d: dir, tag: 'grid' });
  }
  return out;
}

/* ---------- statistik arah (metodologi tools/signal_test.js) ---------- */
function samplesOf(sigs, rows, TS, atr15, b15t) {
  const res = [];
  for (const s of sigs) {
    const j0 = idxAt(TS, s.t), j1 = idxAt(TS, s.t + H);
    if (j0 < 0 || j1 < 0 || j1 <= j0 || TS[j1] < s.t + H - 60000) continue;
    const [b0, a0] = [rows[j0][1], rows[j0][2]], [b1_, a1_] = [rows[j1][1], rows[j1][2]];
    const mid0 = (a0 + b0) / 2;
    const k = doneIdx(b15t, s.t); if (k < 0 || !atr15[k]) continue;
    const atrFrac = atr15[k] / mid0; if (!(atrFrac > 0)) continue;
    const lg = Math.log(((a1_ + b1_) / 2) / mid0);
    const ln = Math.log((s.d > 0 ? b1_ / a0 : a1_ / b0));
    res.push({ t: s.t, d: s.d, atrFrac, rGross: lg, rNet: ln, tag: s.tag });
  }
  return res;
}
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }; }
function edge(list, mu) { const n = list.length; if (!n) return null; const v = list.map(s => (s.rGross - mu) / s.atrFrac);
  return { n, obs: v.reduce((a, x, i) => a + list[i].d * x, 0) / n, v }; }
function drag(list, mu) { if (!list.length) return null; return list.reduce((a, s) => a + s.d * ((s.rNet - mu) / s.atrFrac - (s.rGross - mu) / s.atrFrac), 0) / list.length; }
function boot(list, mu, seed) {
  const st = edge(list, mu); if (!st || st.n < 20) return st && { n: st.n, small: true };
  const n = st.n, v = st.v, d = list.map(s => s.d), rnd = mulberry32(seed), p = 1 / BL, out = [];
  for (let b = 0; b < BOOT; b++) { let s = 0, i = Math.floor(rnd() * n); for (let k = 0; k < n; k++) { s += d[k] * v[i]; if (rnd() < p) i = Math.floor(rnd() * n); else i = (i + 1) % n; } out.push(s / n); }
  out.sort((a, c) => a - c);
  const q = x => out[Math.min(out.length - 1, Math.max(0, Math.floor(x * out.length)))];
  const ge = Math.abs(st.obs), p2 = out.filter(x => Math.abs(x) >= ge).length / out.length;
  let bm = 0; for (const x of out) bm += x; bm /= out.length;
  let bv = 0; for (const x of out) bv += (x - bm) ** 2; bv = Math.sqrt(bv / out.length);
  return { n, obs: st.obs, p2, lo: q(.025), hi: q(.975), z: bv > 0 ? (st.obs - bm) / bv : null };
}
const f3 = v => v == null || !isFinite(v) ? '—' : v.toFixed(3);
let lastBoot = null;
function show(label, list, mu) {
  lastBoot = null;
  if (!list.length) return label.padEnd(24) + 'n=0';
  if (list.length < 20) return label.padEnd(24) + 'n=' + String(list.length).padStart(4) + '  terlalu sedikit (<20) — tidak dinilai';
  const x = boot(list, mu, SEED), dr = drag(list, mu);
  lastBoot = x;
  return label.padEnd(12) + 'n=' + String(x.n).padStart(4) + ' edge=' + f3(x.obs).padStart(7) + ' ATR  p=' + f3(x.p2) + (x.p2 < .05 ? ' ✔' : ' ✘') +
    '  selang95=[' + f3(x.lo) + ',' + f3(x.hi) + ']  drag=' + f3(dr) + '  bersih=' + f3(x.obs + dr);
}
function one(label, list, mu) { const s = show(label, list, mu); console.log('   ' + s); return lastBoot; }

console.log('Uji arah grid-breakout aiterminaltrading vs sinyal engine • horizon ' + (H / 60000) + ' mnt • grid ' + GRID_PIPS +
  ' pips • confirm ' + CONFIRM + ' scan • EMA(M1) ' + EMAN + ' • session=' + SESSION + ' news=' + NEWS + ' • split=' + SPLIT);
console.log('CATATAN: "scan" mereka = 1 detik; data kita 15 detik, jadi CONFIRM=2 di sini = tertahan 30 detik, bukan 2 detik. ' +
  'Konsekuensinya sinyal kita lebih sedikit DAN lebih tertunda — ini versi konservatif dari aturan mereka, bukan salinan identik.\n');

for (const pair of PAIRS) {
  if (!E.PAIRS[pair]) { console.log(pair, 'tidak dikenal'); continue; }
  const src = load(pair); if (!src) { console.log(pair, 'NO DATA'); continue; }
  const P = E.PAIRS[pair], rows = src.rows, TS = rows.map(r => r[0]);
  const pip = P.pip, step = GRID_PIPS * pip;
  const b1 = bars(rows, 1), b1t = b1.map(x => x.t), ema = emaOf(b1, EMAN);
  const b15 = bars(rows, 15), b15t = b15.map(x => x.t), atr15 = atrOf(b15, 14);
  const gsig = gridSignals(rows, pip, b1, b1t, ema, step);
  /* sinyal engine mentah (arah per evaluate, tanpa gerbang) — pembanding yang sepadan:
     keduanya "mesin bilang UP/DOWN", yang diuji hanya isi informasinya */
  const bakH = E.PAIRS[pair].hours, bakC = E.PAIRS[pair].calib;
  E.PAIRS[pair].hours = null; E.PAIRS[pair].calib = null;
  const eng = E.create(pair, { mode: MODE, stale: 60000, feed: 'bt' });
  const esig = []; let lastEval = 0;
  for (const [t, b, a] of rows) { eng.onTick(t, b, a); if (t - lastEval < EVAL) continue; lastEval = t; const o = eng.evaluate(t); if (o.status === 'ok' && (o.side === 'UP' || o.side === 'DOWN')) esig.push({ t, d: o.side === 'UP' ? 1 : -1, score: o.score, f: o.f }); }
  E.PAIRS[pair].hours = bakH; E.PAIRS[pair].calib = bakC;

  const dedupe = list => { const out = []; let next = 0; for (const s of list) { if (s.t < next) continue; out.push(s); next = s.t + STRIDE } return out; };
  const gs = samplesOf(dedupe(gsig), rows, TS, atr15, b15t);
  const es = samplesOf(dedupe(esig), rows, TS, atr15, b15t);
  const t0 = TS[0], t1 = TS[TS.length - 1], split = t0 + (t1 - t0) * SPLIT;
  const all = gs.concat(es);
  const mu = all.length ? all.reduce((a, s) => a + s.rGross, 0) / all.length : 0;
  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + ((t1 - t0) / 86400000).toFixed(1) + ' hari, grid = ' + step.toFixed(P.dp) + ') ====');
  console.log('   sinyal: grid ' + gsig.length + ' → ' + gs.length + ' sampel | engine ' + esig.length + ' → ' + es.length + ' sampel');
  const gTr = gs.filter(s => s.t < split), gTe = gs.filter(s => s.t >= split);
  const eTr = es.filter(s => s.t < split), eTe = es.filter(s => s.t >= split);
  console.log('   grid mereka (breakout sel ' + GRID_PIPS + 'p, EMA searah)');
  one('     TRAIN', gTr, mu); one('     TEST ', gTe, mu);
  console.log('   engine ini (arah mentah dari evaluate, tanpa gerbang)');
  const bG = one('     TRAIN', eTr, mu); const bE = one('     TEST ', eTe, mu);
  /* Irisan: apakah grid mereka menambah informasi di luar engine, atau cuma mengulang arah yang sama? */
  const near = (a, b) => Math.abs(a.t - b.t) <= H;
  const agree = [], disagree = [];
  for (const s of gTe) { const m = eTe.filter(x => near(x, s))[0]; if (!m) continue; (m.d === s.d ? agree : disagree).push(s); }
  console.log('   di TEST yang berimpit dengan sinyal engine (±1 horizon): searah ' + agree.length + ' • berlawanan ' + disagree.length);
  one('     searah  ', agree, mu); one('     berlawanan', disagree, mu);
  if (bG && bE) console.log('   → selisih edge TEST (grid − engine) = ' + f3(bG.obs - bE.obs) + ' ATR. Dua-duanya angka sendiri: tidak ada uji beda dua sampel di sini, jadi selisih kecil jangan dibaca sebagai kesimpulan.');
  console.log('');
}
