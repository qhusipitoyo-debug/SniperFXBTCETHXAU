#!/usr/bin/env node
/* Corong gerbang untuk major FX: dari N evaluasi, gerbang mana yang mematikan sampai
   trade nyaris nol (tindak lanjut tools/_fx_hour_calib.js: n=0–4 per pair, jam tak bisa dinilai).
   Satu engine run, semua angka direkonstruksi dari out.f — kosakata gerbang sama dengan
   tools/signal_test.js supaya hasilnya bisa disandingkan.

   Pakai: node tools/_fx_funnel.js [EURUSD GBPUSD ...] [--mode balanced] [--eval 2000]
*/
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const MODE = opt('mode', 'balanced');
const EVAL = Number(opt('eval', 2000));
const keys = args.filter(a => !a.startsWith('--') && E.PAIRS[a.toUpperCase()]).map(s => s.toUpperCase());
const PAIRS = keys.length ? keys : ['EURUSD', 'GBPUSD', 'USDJPY', 'USDCHF', 'AUDUSD', 'USDCAD', 'NZDUSD'];

function load(pair) {
  /* Data Deriv sendiri (data/<PAIR>_1m.csv) didahulukan: EURUSDT/Binance ternyata proxy yang
     buruk untuk EURUSD — simpangan 44 pips median dari median-nya sendiri, 985 lompatan >15 pips
     dalam 45 hari (maks 309 pips), dan itu membuka gerbang biaya lewat artefak, bukan likuiditas. */
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
const pct = (arr, q) => { if (!arr.length) return NaN; const s = arr.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]; };

console.log('FX gate funnel • mode=' + MODE + ' eval=' + EVAL + 'ms • hours dipaksa 0-23 (bukan allowlist)\n');
for (const pair of PAIRS) {
  const src = load(pair);
  if (!src) { console.log(pair, 'NO DATA'); continue; }
  const P = E.PAIRS[pair], prm = E.PARAMS, mode = E.MODES[MODE];
  const bak = P.hours; P.hours = null;                     // jangan kena allowlist
  const bakSess = P.sess; P.sess = [0, 24];                // dan jangan kena rentang sesi
  const eng = E.create(pair, { mode: MODE, stale: 60000, feed: 'bt' });
  let last = 0;
  const rec = [];
  const stat = { ticks: 0, ok: 0, hardClosed: 0, hardNews: 0, blocked: 0, fired: 0, progMax: 0, persistHit: 0 };
  for (const [t, b, a] of src.rows) {
    eng.onTick(t, b, a); stat.ticks++;
    if (t - last < EVAL) continue; last = t;
    const o = eng.evaluate(t);
    if (o.hard === 'Pasar tutup') { stat.hardClosed++; continue; }
    if (o.hard) { stat.hardNews++; continue; }
    if (o.status !== 'ok' || !o.f) continue;
    stat.ok++;
    if (o.prog > stat.progMax) stat.progMax = o.prog;
    if (o.prog >= mode.persist) stat.persistHit++;
    if (o.fired) stat.fired++;
    stat.blocked += o.blocked ? 1 : 0;
    rec.push({ t, d: o.side === 'UP' ? 1 : -1, score: o.score, f: o.f, prog: o.prog });
  }
  P.hours = bak; P.sess = bakSess;

  const GATES = [
    ['ATR/biaya', s => s.f.costRatio >= mode.minCost],
    ['ER (choppy)', s => s.f.er >= mode.minER],
    ['Skor', s => Math.abs(s.score) >= mode.minScore],
    ['Mom&trend searah', s => Math.sign(s.f.mom) === s.d && Math.sign(s.f.trend) === s.d],
    ['Mom&trend cukup', s => Math.abs(s.f.mom) >= prm.MIN_MOM && Math.abs(s.f.trend) >= prm.MIN_TREND],
    ['HTF tidak lawan', s => s.f.htf * s.d >= prm.HTF_SOFT],
    ['Brk floor', s => s.f.brk >= prm.BRK_FLOOR],
    ['Brk ceil', s => s.f.brk <= prm.BRK_CEIL],
    ['z jangan kejar', s => s.f.z60d <= prm.MAX_Z60 && s.f.z180d <= prm.MAX_Z180],
    ['retrace', s => s.f.retrace <= prm.MAX_RETRACE_ATR],
    ['SL swing valid', s => !s.f.slTooFar],
    ['spread', s => s.f.spreadPips <= P.maxSpread],
    ['spike volatilitas', s => s.f.volRatio <= prm.SPIKE_MAX]
  ];
  const fail = GATES.map(([k, f]) => [k, rec.filter(s => !f(s)).length]);
  const survive = GATES.map(([k, f]) => [k, rec.filter(s => f(s)).length]);
  const allPass = rec.filter(s => GATES.every(([, f]) => f(s))).length;

  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + src.rows.length + ' tick) ====');
  console.log('eval ok=' + stat.ok + '  pasar-tutup=' + stat.hardClosed + '  berita=' + stat.hardNews +
    '  blocked=' + stat.blocked + '  prog≥persist=' + stat.persistHit + '  fired=' + stat.fired +
    '  progMax=' + (stat.progMax / 1000).toFixed(0) + 's  (persist ' + (mode.persist / 1000) + 's)');
  console.log('  perbandingan vs ambang (persentil 50/90/99):');
  console.log('   ATR/biaya   ' + pct(rec.map(s => s.f.costRatio), .5).toFixed(2) + ' / ' +
    pct(rec.map(s => s.f.costRatio), .9).toFixed(2) + ' / ' + pct(rec.map(s => s.f.costRatio), .99).toFixed(2) +
    '   butuh ≥' + mode.minCost);
  console.log('   ER          ' + pct(rec.map(s => s.f.er), .5).toFixed(2) + ' / ' +
    pct(rec.map(s => s.f.er), .9).toFixed(2) + ' / ' + pct(rec.map(s => s.f.er), .99).toFixed(2) +
    '   butuh ≥' + mode.minER);
  console.log('   |skor|      ' + pct(rec.map(s => Math.abs(s.score)), .5).toFixed(2) + ' / ' +
    pct(rec.map(s => Math.abs(s.score)), .9).toFixed(2) + ' / ' + pct(rec.map(s => Math.abs(s.score)), .99).toFixed(2) +
    '   butuh ≥' + mode.minScore);
  console.log('   ATR pips    ' + pct(rec.map(s => s.f.atrP), .5).toFixed(1) + ' / ' +
    pct(rec.map(s => s.f.atrP), .9).toFixed(1) + ' / ' + pct(rec.map(s => s.f.atrP), .99).toFixed(1) +
    '   (biaya ' + pct(rec.map(s => s.f.cost), .5).toFixed(1) + ' pips)');
  console.log('  gerbang yang PALING sering menolak (dari ' + rec.length + ' eval dalam sesi):');
  fail.slice().sort((a, b) => b[1] - a[1]).forEach(([k, n]) => {
    if (!n) return;
    console.log('   ' + k.padEnd(19) + String(n).padStart(7) + '  ' + ((n / rec.length) * 100).toFixed(1).padStart(5) + '%  lolos=' +
      String(survive.find(x => x[0] === k)[1]).padStart(7));
  });
  console.log('  lolos SEMUA gerbang sekaligus: ' + allPass + ' eval (' + ((allPass / Math.max(1, rec.length)) * 100).toFixed(3) + '%)');
  /* Gerbang biaya jadi penyebab utama → berapa besar biaya boleh supaya gerbangnya terbuka.
     atrP tidak bergantung biaya, jadi ini bisa dihitung ulang dari rekaman yang sama. */
  const atr = rec.map(s => s.f.atrP);
  console.log('  bila BIAYA (pips round-trip) diturunkan, eval dalam sesi yang lolos ATR/biaya ' + mode.minCost + '×:');
  const costs = Array.from(new Set([P.typSpread, 3, 2.5, 2, 1.5, 1, 0.7])).sort((a, b) => b - a);
  for (const c of costs) {
    const n = atr.filter(v => v >= mode.minCost * c).length;
    console.log('   biaya ' + c.toFixed(1).padStart(4) + ' pips → ' + String(n).padStart(7) + ' eval (' + ((n / Math.max(1, atr.length)) * 100).toFixed(2).padStart(6) + '%)' +
      (c === P.typSpread ? '   ← typSpread pair ini sekarang' : ''));
  }
  const ablate = GATES.map(([k, f], i) => [k, rec.filter(s => GATES.every(([, g], j) => j === i || g(s))).length]);
  console.log('  ablation (buang satu gerbang, berapa eval lolos sisanya):');
  ablate.sort((a, b) => b[1] - a[1]).forEach(([k, n]) => console.log('   -' + k.padEnd(19) + String(n).padStart(8)));
  console.log('  trade closed n=' + E.summarize(eng.closed).n + '  ' + JSON.stringify(eng.closed.slice(-3).map(t => ({ t: new Date(t.t).toISOString().slice(0, 16), side: t.side, why: t.done, R: Number(t.resultR).toFixed(2) }))));
  console.log('');
}
