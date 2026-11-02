#!/usr/bin/env node
/* Lanjutan tools/_fx_funnel.js: gerbang ATR/biaya membunuh major FX (89,8–100% eval ditolak,
   AUD/CAD/NZD nol eval yang lolos). Pertanyaannya bukan "apa gerbangnya salah" tapi
   "kalau ambangnya diturunkan sampai major FX benar-benar menghasilkan trade, apa yang keluar?"
   Kalau di titik itu avgR tetap negatif, kalibrasi jam untuk major FX tidak ada gunanya —
   tidak ada trade yang bisa dibagi per jam.

   Pakai: node tools/_fx_mincost_sweep.js [GBPUSD USDJPY ...] [--mode balanced] [--eval 2000]
*/
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? Number(f.split('=')[1]) : d; };
const MODE = opt('mode', 'balanced');
const EVAL = opt('eval', 2000);
const given = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
const PAIRS = (given.length ? given : ['GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD', 'EURUSD'])
  .filter(k => E.PAIRS[k]);
const LEVELS = [3.5, 3.0, 2.5, 2.0, 1.75, 1.5, 1.25, 1.0, 0.8];

function load(pair) {
  const cands = [path.join(__dirname, '../data', pair + '_1m.csv'),
                 E.PAIRS[pair].binance && path.join(__dirname, '../data', String(E.PAIRS[pair].binance).toUpperCase() + '_1m.csv')
  ].filter(Boolean);
  for (const f of cands) {
    if (!fs.existsSync(f)) continue;
    const rows = [];
    for (const line of fs.readFileSync(f, 'utf8').split(/\n/)) {
      const c = line.split(','); if (c.length < 3) continue;
      const t = Number(c[0]), b = Number(c[1]), a = Number(c[2]);
      if (t && b > 0 && a >= b) rows.push([t, b, a]);
    }
    if (rows.length >= 1000) return { file: f, rows };
  }
  return null;
}
function f(s) {
  if (!s.n) return 'n=0';
  return 'n=' + String(s.n).padStart(4) + ' wr=' + ((s.winRate || 0) * 100).toFixed(1).padStart(5) + '% avgR=' +
    (s.avgR || 0).toFixed(3).padStart(7) + ' PF=' + (s.pf == null ? '—  ' : s.pf.toFixed(2)).padStart(4) +
    ' tot=' + (s.totalR || 0).toFixed(2).padStart(8) + ' DD=' + (s.maxDD || 0).toFixed(1);
}
function hours(tr) {
  const h = {};
  for (const t of tr) { const k = new Date(t.t).getUTCHours(); const b = h[k] || (h[k] = { n: 0, s: 0 }); b.n++; b.s += t.resultR; }
  return Object.keys(h).map(Number).sort((a, b) => a - b).map(k => k + ':' + h[k].n + '/' + (h[k].s / h[k].n).toFixed(2));
}

console.log('FX minCost sweep • mode=' + MODE + ' eval=' + EVAL + ' • hours=[semua] (allowlist dilepas supaya corongnya kelihatan)\n');
for (const pair of PAIRS) {
  const src = load(pair);
  if (!src) { console.log(pair, 'NO DATA'); continue; }
  const P = E.PAIRS[pair], bakH = P.hours, bakS = P.sess;
  P.hours = null; P.sess = [0, 24];
  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + src.rows.length + ' tick, biaya data ' + P.typSpread + ' pips) ====');
  for (const mc of LEVELS) {
    const eng = E.create(pair, { mode: MODE, modeOverride: { minCost: mc }, stale: 60000, feed: 'bt' });
    let last = 0;
    for (const [t, b, a] of src.rows) { eng.onTick(t, b, a); if (t - last < EVAL) continue; last = t; eng.evaluate(t); }
    const s = E.summarize(eng.closed);
    console.log('  minCost=' + String(mc).padStart(4) + '  ' + f(s) + '   jam(n/avgR): ' + (s.n >= 6 ? hours(eng.closed).join(' ') : '—'));
  }
  P.hours = bakH; P.sess = bakS;
  console.log('');
}
