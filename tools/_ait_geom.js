#!/usr/bin/env node
/* ============================================================
   GEOMETRI TP/SL — referensi pitoyict13-droid/aiterminaltrading vs geometri kita
   -------------------------------------------------------------
   Pertanyaannya bukan "mana yang lebih bagus di angka", tapi: kalau ENTRY-nya sama,
   apakah bentuk SL/TP mereka (pip tetap / % tetap, BE di +1R, tanpa parsial, tanpa
   time-stop) menghasilkan harapan yang lebih baik setelah BIAYA ritel dibayar?

   Cara yang jujur: ENTRY dipegang tetap (satu set trade dari engine hidup), lalu tiap
   setiran (SL, TP, BE, parsial, TTL) dijalankan ulang di atas barisan tick yang sama.
   Ini perbandingan BERPASANGAN — trade yang sama, keluar yang berbeda — jadi selisih
   avgR benar-benar berasal dari geometri, bukan dari sampel yang berbeda.

   Batasan yang harus dibaca bersama hasilnya:
     1) Set entry dipegang tetap. Varian yang keluar lebih cepat lẽanya bisa mengambil
        lebih banyak trade; di sini jumlahnya sengaja disamakan supaya yang diukur hanya
        sisi keluar. Angka "n" bukan kapasitas tiap varian.
     2) Geometri mereka tidak bisa dipakai di pair yang sinyalnya 0 (mayor FX): entry
        berasal dari engine, jadi yang terukur cuma XAU/BTC/ETH yang punya trade.
     3) Spread dibayar dari data (entry di ask/bid, keluar di sisi lawan) — bukan asumsi.
        Kolom "biayaR" = rata-rata spread ÷ jarak SL, dalam satuan R. Itu kerugian pasti
        tiap varian, dan alasan kenapa SL 15 pips mereka tidak bisa ditransplantasikan
        ke broker dengan typSpread 2,8–4,5 pips.

   Pemakaian: node tools/_ait_geom.js [XAUUSD BTCUSD ETHUSD] [--split=0.6] [--mode=balanced]
                                       [--eval=2000] [--min-n=20]
   ============================================================ */
'use strict';
const fs = require('fs');
const path = require('path');
const E = require('../engine.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const SPLIT = Number(opt('split', .6));
const EVAL = Number(opt('eval', 2000));
const MODE = opt('mode', 'balanced');
const MIN_N = Number(opt('min-n', 20));
const LIST = (args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase()).length
  ? args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase())
  : ['XAUUSD', 'BTCUSD', 'ETHUSD']);

const P0 = E.PARAMS;

/* ---------------- geometri yang diuji ----------------
   sl: ({atr,pip,entry,spread,atrD1}) → jarak SL dalam harga   (null = tidak berlaku utk pair ini)
   tp1R: target parsial (R) + frac; tp2R: target akhir (R). BE: beR (R), beBuf = tambah spread+2 pips.
   Sumber tiap baris: default argparse mt5_grid_hft.py, kartu BUY/SELL index.html, dan preset pineSnR.txt. */
const GEOMS = [
  { key: 'kita', name: 'kita: SL engine (max 3,2×ATR-M15/lantai biaya/swing) · TP 1R/2,2R parsial 50% · BE 0,4R · TTL 60m',
    pairs: null, sl: s => s.slDist, tp1R: P0.TP1_R, tp2R: P0.TP2_R, frac: P0.TP1_FRAC, beR: P0.BE_AT_R, ttl: P0.PLAN_TTL,
    note: 'replay ini HARUS sama dengan angka engine — dipakai sebagai cek validasi' },
  { key: 'grid1530', name: 'ait: SL 15p / TP 30p (RR 1:2) · BE +1R+buf · tanpa parsial · tanpa TTL',
    pairs: null, pip: 15, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'page3060', name: 'ait(laman): SL 30p / TP 60p · BE +1R+buf · tanpa parsial · tanpa TTL',
    pairs: ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'], pip: 30, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'pct50100', name: 'ait(emas post-news): SL 0,50% / TP 1,00% · BE +1R+buf · tanpa TTL',
    pairs: ['XAUUSD'], pct: .5, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'pctstrad', name: 'ait(emas straddle pre-news): buffer 0,25% → SL 0,375% / TP 0,75%',
    pairs: ['XAUUSD'], pct: .375, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'btc1020', name: 'ait(BTC): SL 1,0% / TP 2,0% · BE +1R+buf',
    pairs: ['BTCUSD'], pct: 1, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'eth1530', name: 'ait(ETH): SL 1,5% / TP 3,0% · BE +1R+buf',
    pairs: ['ETHUSD'], pct: 1.5, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0 },
  { key: 'gridD1', name: 'ait(pine): grid 0,25×ATR(D1) → SL 1 grid / TP 2 grid · BE +1R+buf',
    pairs: null, grid: 1, tp2R: 2, frac: 0, beR: 1, beBuf: true, ttl: 0, k: .25 },
  { key: 'pineC3', name: 'ait(pine C1–C3 default): SL 3 grid / TP 1 grid (RR 0,33) · BE +1R+buf',
    pairs: null, grid: 3, tp2R: 1 / 3, frac: 0, beR: 1, beBuf: true, ttl: 0, k: .25 },
  { key: 'pineC4', name: 'ait(pine C4/C5): SL 2 grid / TP 1 grid (RR 0,5) · BE +1R+buf',
    pairs: null, grid: 2, tp2R: .5, frac: 0, beR: 1, beBuf: true, ttl: 0, k: .25 },
  /* Kontrol: geometri kita TANPA time-stop dan TANPA parsial — memisahkan efek "TTL 60 menit"
     dari efek bentuk SL/TP. Tanpa ini, kalah-menang varian mereka bisa datang dari hal yang salah. */
  { key: 'kitaNoTtl', name: 'kita tanpa TTL & tanpa parsial: SL 3,2×ATR(M15) / TP 2,2R saja',
    pairs: null, sl: s => s.slDist, tp2R: P0.TP2_R, frac: 0, beR: P0.BE_AT_R, ttl: 0 }
];

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

/* ATR(D1) Wilder-14 dari mid, hanya memakai hari yang SUDAH selesai (setara ta.atr(14)[1] di pine).
   Tanpa itu, grid ATR(D1) bocor masa depan. */
function atrD1Table(rows) {
  const days = [];
  let cur = null;
  for (const [t, b, a] of rows) {
    const day = Math.floor(t / 86400000);
    const mid = (a + b) / 2;
    if (!cur || cur.day !== day) { cur = { day, h: mid, l: mid, c: mid }; days.push(cur); }
    if (mid > cur.h) cur.h = mid; if (mid < cur.l) cur.l = mid; cur.c = mid;
  }
  const out = []; let atr = null;
  for (let i = 0; i < days.length; i++) {
    const d = days[i], prev = days[i - 1];
    const tr = !prev ? (d.h - d.l) : Math.max(d.h - prev.c, d.l - prev.c, d.h - d.l);
    if (i < 14) { if (i === 13) { atr = days.slice(0, 14).reduce((s, x, k) => s + (k ? Math.max(x.h - days[k - 1].c, x.l - days[k - 1].c, x.h - x.l) : x.h - x.l), 0) / 14; out[i] = atr; } else out[i] = null; continue; }
    atr = (atr * 13 + tr) / 14; out[i] = atr;
  }
  return { dayIdx: days.map(d => d.day), val: out };
}
function d1At(tab, day) {
  let lo = 0, hi = tab.dayIdx.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (tab.dayIdx[m] <= day) { r = m; lo = m + 1 } else hi = m - 1 }
  /* pakai nilai hari sebelumnya supaya tidak menghitung TR hari yang masih berjalan */
  return r > 0 ? tab.val[r - 1] : null;
}

/* satu engine-run hidup: entry yang sama untuk semua varian */
function harvest(pair, rows, fromMs) {
  const bakH = E.PAIRS[pair].hours, bakC = E.PAIRS[pair].calib;
  E.PAIRS[pair].hours = null; E.PAIRS[pair].calib = null;   // jam/allowlist dilepas: geometri diuji sendiri
  const eng = E.create(pair, { mode: MODE, stale: 60000, feed: 'bt' });
  let last = fromMs ? fromMs - 1e12 : 0;
  for (const [t, b, a] of rows) {
    if (fromMs && t < fromMs) continue;
    eng.onTick(t, b, a);
    if (t - last < EVAL) continue; last = t;
    eng.evaluate(t);
  }
  E.PAIRS[pair].hours = bakH; E.PAIRS[pair].calib = bakC;
  return eng.closed.slice();
}

/* replika manage() engine (baris 313–331) dengan setiran geometri dari luar */
function replay(rows, TS, tr, g, pair, tab) {
  const P = E.PAIRS[pair], pip = P.pip, buy = tr.side === 'UP', d = buy ? 1 : -1;
  const slD = slOf(tr, g, pair, tab);
  if (!(slD > 0)) return null;
  const tp1 = g.tp1R != null ? slD * g.tp1R : null;
  const tp2 = g.tp2R != null ? slD * g.tp2R : null;
  const beD = g.beR != null ? slD * g.beR : null;
  const buf = g.beBuf ? tr.spread + 2 * pip : 0;
  const F = g.frac || 0;
  const tEnd = g.ttl ? tr.t + g.ttl : Infinity;
  let sl = tr.entry - d * slD, tp1hit = false, beArmed = false;
  const i0 = (() => { let lo = 0, hi = TS.length - 1, r = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (TS[m] <= tr.t) { r = m; lo = m + 1 } else hi = m - 1 } return r; })();
  for (let i = i0 + 1; i < rows.length; i++) {
    const t = rows[i][0], px = buy ? rows[i][1] : rows[i][2];
    const r = (buy ? px - tr.entry : tr.entry - px) / slD;
    if (buy ? px <= sl : px >= sl) {
      const be = tp1hit || beArmed;
      return { why: be ? (tp1hit ? 'BE/TP1' : 'BE') : 'SL', R: (tp1hit ? F * g.tp1R + (1 - F) * r : r) - (P0.COST_EXTRA_PIPS || 0) * pip / slD };
    }
    if (beD && !tp1hit && !beArmed && r >= g.beR) { beArmed = true; sl = tr.entry + d * buf; }
    if (tp1 && !tp1hit && (buy ? px >= tr.entry + tp1 : px <= tr.entry - tp1)) { tp1hit = true; sl = tr.entry + d * buf; }
    if (tp2 && (tp1hit || !tp1) && (buy ? px >= tr.entry + tp2 : px <= tr.entry - tp2))
      return { why: tp1 ? 'TP2' : 'TP', R: (tp1 ? F * g.tp1R + (1 - F) * g.tp2R : g.tp2R) - (P0.COST_EXTRA_PIPS || 0) * pip / slD };
    if (t > tEnd) { const r2 = (buy ? px - tr.entry : tr.entry - px) / slD; return { why: 'TIME', R: (tp1hit ? F * g.tp1R + (1 - F) * r2 : r2) - (P0.COST_EXTRA_PIPS || 0) * pip / slD }; }
  }
  const lastPx = buy ? rows[rows.length - 1][1] : rows[rows.length - 1][2];
  return { why: 'EOF', R: (buy ? lastPx - tr.entry : tr.entry - lastPx) / slD };
}

/* jarak SL varian ini untuk trade t (harga) — null kalau tidak bisa dihitung */
function slOf(t, g, pair, tab) {
  const P = E.PAIRS[pair], pip = P.pip;
  /* t.atr dari engine sudah satuan harga (bukan pips) — lihat slInfo() yang membandingkannya
     dengan MIN_SL_PIPS*P.pip. slDist = jarak SL yang benar-benar dipakai engine (termasuk lantai
     biaya/swing), jadi varian 'kita' mereplikasi engine, bukan menirunya dengan 3,2×ATR saja. */
  const ctx = { atr: t.atr, slDist: t.slDist, pip, entry: t.entry, spread: t.spread, atrD1: tab ? d1At(tab, Math.floor(t.t / 86400000)) : null };
  if (g.sl) return g.sl(ctx);
  if (g.pip) return g.pip * pip;
  if (g.pct) return t.entry * g.pct / 100;
  if (g.grid) return ctx.atrD1 ? g.k * ctx.atrD1 * g.grid : null;
  return null;
}

function stat(list) {
  const n = list.length; if (!n) return { n: 0 };
  const R = list.map(x => x.R);
  const win = R.filter(x => x > 0).length, gp = R.filter(x => x > 0).reduce((a, x) => a + x, 0), gl = -R.filter(x => x < 0).reduce((a, x) => a + x, 0);
  const mix = {}; list.forEach(x => { mix[x.why] = (mix[x.why] || 0) + 1 });
  return { n, winRate: win / n, avgR: R.reduce((a, x) => a + x, 0) / n, totalR: R.reduce((a, x) => a + x, 0),
    pf: gl > 0 ? gp / gl : (gp > 0 ? Infinity : null), mix,
    costR: list.reduce((a, x) => a + x.costR, 0) / n, slPips: list.reduce((a, x) => a + x.slPips, 0) / n };
}
const line = s => !s.n ? 'n=0'.padStart(6) : 'n=' + String(s.n).padStart(3) + ' wr=' + (s.winRate * 100).toFixed(1).padStart(5) + '%' +
  ' avgR=' + s.avgR.toFixed(3).padStart(7) + ' PF=' + (s.pf == null ? '—  ' : (s.pf === Infinity ? '∞  ' : s.pf.toFixed(2))).padStart(4) +
  ' tot=' + s.totalR.toFixed(2).padStart(7) + ' biaya=' + s.costR.toFixed(3).padStart(6) + 'R SL≈' + s.slPips.toFixed(0).padStart(4) + 'p';
/* rata-rata ± SE selisih berpasangan. SE = sd/√n — aproksimasi normal pada seri R yang
   berekor tebal, jadi perlakukan |Δ| < 2 SE sebagai "tidak terukur", bukan sebagai "sama". */
function paired(d) { const n = d.length; if (n < 2) return null; const m = d.reduce((a, x) => a + x, 0) / n;
  return { n, m, se: Math.sqrt(d.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1) / n) }; }
const mixStr = m => { const tot = Object.values(m || {}).reduce((a, b) => a + b, 0); if (!tot) return '';
  return Object.entries(m).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + (v * 100 / tot).toFixed(0) + '%').join(' '); };

for (const pair of LIST) {
  if (!E.PAIRS[pair]) { console.log(pair, 'tidak dikenal'); continue; }
  const src = load(pair);
  if (!src) { console.log(pair, 'NO DATA'); continue; }
  const rows = src.rows, TS = rows.map(r => r[0]);
  const t0 = TS[0], t1 = TS[TS.length - 1], split = t0 + (t1 - t0) * SPLIT;
  const tab = atrD1Table(rows);
  const P = E.PAIRS[pair];
  const spreadAvg = rows.slice(0, 20000).reduce((a, r) => a + (r[2] - r[1]), 0) / Math.min(20000, rows.length);
  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + rows.length + ' tick, ' +
    ((t1 - t0) / 86400000).toFixed(1) + ' hari) ====');
  console.log('   spread data rata-rata = ' + (spreadAvg / P.pip).toFixed(2) + ' pips (typSpread tabel ' + P.typSpread +
    ') — executor mereka mensyaratkan --max-spread-pips 1.5, jadi di broker ini geometri pip-tetap mereka TIDAK akan pernah entry');

  const tr = harvest(pair, rows, null);
  const engR = stat(tr.map(x => ({ why: x.done, R: x.resultR, costR: 0, slPips: x.slDist / P.pip })));
  console.log('   entry engine (shipped): ' + engR.n + ' trade  avgR ' + (engR.avgR || 0).toFixed(3) + '  (TRAIN ' +
    tr.filter(x => x.t < split).length + ' / TEST ' + tr.filter(x => x.t >= split).length + ')\n');
  if (!tr.length) { console.log('   tidak ada entry — geometri tidak bisa diuji di pair ini (lihat funnel: gerbang ATR/biaya).\n'); continue; }

  /* Acuan berpasangan: hasil replay geometri KITA per trade. Selisih Δ dihitung trade-per-trade
     (bukan selisih dua rata-rata dari sampel berbeda) supaya tenaga statistiknya terpakai. */
  const gKita = GEOMS.find(x => x.key === 'kita');
  const base = tr.map(t => { const r = replay(rows, TS, t, gKita, pair, tab); return r ? r.R : null; });

  for (const g of GEOMS) {
    if (g.pairs && g.pairs.indexOf(pair) < 0) continue;
    const out = [], seen = [], dl = [];
    tr.forEach((t, i) => {
      const res = replay(rows, TS, t, g, pair, tab);
      if (!res) { dl.push(null); return; }
      const sd = slOf(t, g, pair, tab);
      res.costR = t.spread / sd;
      res.slPips = sd / P.pip;
      out.push(res); seen.push(t.t); dl.push(base[i] == null ? null : res.R - base[i]);
    });
    if (!out.length) { console.log('   ' + g.name + '  TIDAK BISA DIUJI (ATR D1 belum tersedia / tidak berlaku untuk pair ini)'); continue; }
    const sTr = stat(out.filter((_, i) => seen[i] < split)), sTe = stat(out.filter((_, i) => seen[i] >= split));
    console.log('   ' + g.name);
    console.log('     TRAIN ' + line(sTr));
    console.log('     TEST  ' + line(sTe) + '   keluar: ' + mixStr(sTe.mix));
    const pTr = paired(dl.filter((x, i) => x != null && tr[i].t < split)), pTe = paired(dl.filter((x, i) => x != null && tr[i].t >= split));
    if (g.key !== 'kita') console.log('     Δ vs exit kita (Trade/TEST): ' + (pTr ? pTr.m.toFixed(3) + '±' + pTr.se.toFixed(3) + 'R' : '—') +
      ' / ' + (pTe ? pTe.m.toFixed(3) + '±' + pTe.se.toFixed(3) + 'R' : '—') +
      (pTe && Math.abs(pTe.m) < 2 * pTe.se ? '   → |Δ| < 2 SE: tidak terbedakan dari nol pada n=' + pTe.n : '   → |Δ| ≥ 2 SE: nyata pada n=' + pTe.n));
    if (g.key === 'kita') {
      const engTe = stat(tr.filter(x => x.t >= split).map(x => ({ why: x.done, R: x.resultR, costR: 0, slPips: 0 })));
      console.log('     cek replikasi vs engine: ΔavgR TEST = ' + Math.abs((sTe.avgR || 0) - (engTe.avgR || 0)).toFixed(4) +
        ' (harus ≈ 0; sisa yang kecil itu pembulatan rd() engine ke desimal pair — level SL/TP engine dibulatkan, replay tidak)');
    }
  }
  console.log('');
}
