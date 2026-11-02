#!/usr/bin/env node
/* Uji JAM OUT-OF-SAMPLE — menambal lubang di kalibrasi v6.
   tools/_fx_hour_calib.js / _hour_probe.js memilih allowlist dari rata-rata per jam pada
   jendela yang SAMA dengan tempat angka PF/avgR-nya dilaporkan (in-sample selection):
   "buang jam jelek" selalu terlihat lebih baik di data itu sendiri, terlepas jamnya benar-benar jelek.
   Alat ini memisahkan keduanya:

     A. baseline       : hours=null (semua jam boleh)          → dinilai di TEST saja
     B. allowlist TRAIN: jam dipilih dari TRAIN (60% awal)     → dinilai di TEST saja  ← angka yang boleh dipercaya
     C. shipped        : allowlist yang sekarang ada di engine.js (dipilih in-sample) → dinilai di TEST saja

   Semua jalur lewat LIVE-GATE engine (allowlist dipasang sebelum run), bukan post-filter,
   supaya efek jam terhadap state machine (cooldown, latch, plan aktif) ikut dihitung —
   sama seperti tools/_validate_calib.js. Satu run per allowlist, jendela TRAIN/TEST dipisah
   dari trade yang sama (mahal: 365 hari × 2 juta tick per pass).

   Pakai: node tools/_hour_oos.js XAUUSD BTCUSD ETHUSD --split=0.6
          node tools/_hour_oos.js            # default XAU + BTC (365 hari) + ETH (45 hari)
*/
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const SPLIT = Number(opt('split', .6));
const EVAL = Number(opt('eval', 2000));
const MODE = opt('mode', 'balanced');
const MIN_N = Number(opt('min-n', 6));   // jam dengan trade cukup untuk dinilai di TRAIN
const GOOD = Number(opt('good', 0.02));  // avgR minimum agar jam dianggap layak
const PAIRS = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
const LIST = PAIRS.length ? PAIRS : ['XAUUSD', 'BTCUSD', 'ETHUSD'];

function load(pair) {
  const cands = [path.join(__dirname, '../data', pair + '_1m.csv'),
                 E.PAIRS[pair] && E.PAIRS[pair].binance && path.join(__dirname, '../data', String(E.PAIRS[pair].binance).toUpperCase() + '_1m.csv')
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

/* Satu pass live-gate: pasang allowlist (null = semua jam), jalankan, kembalikan semua trade tertutup. */
function runAll(pair, rows, hours) {
  const bak = E.PAIRS[pair].hours;
  E.PAIRS[pair].hours = hours;
  const eng = E.create(pair, { mode: MODE, stale: 60000, feed: 'bt' });
  let last = 0;
  for (const [t, b, a] of rows) {
    eng.onTick(t, b, a);
    if (t - last < EVAL) continue; last = t;
    eng.evaluate(t);
  }
  E.PAIRS[pair].hours = bak;
  return eng.closed.slice();
}
function byHour(trades) {
  const h = {};
  for (const t of trades) {
    if (typeof t.resultR !== 'number') continue;
    const k = new Date(t.t).getUTCHours();
    const b = h[k] || (h[k] = { n: 0, w: 0, g: 0, l: 0 });
    b.n++; if (t.resultR > 0) { b.w++; b.g += t.resultR } else b.l -= t.resultR;
  }
  return Object.keys(h).map(Number).sort((a, b) => a - b)
    .map(k => { const b = h[k]; return { h: k, n: b.n, wr: b.w / b.n, avgR: (b.g - b.l) / b.n, pf: b.l > 0 ? b.g / b.l : null }; });
}
function line(s) {
  if (!s.n) return 'n=0'.padStart(6);
  return 'n=' + String(s.n).padStart(3) + ' wr=' + ((s.winRate || 0) * 100).toFixed(1).padStart(5) + '%' +
    ' avgR=' + (s.avgR || 0).toFixed(3).padStart(7) + ' PF=' + (s.pf == null ? '—  ' : s.pf.toFixed(2)).padStart(4) +
    ' tot=' + (s.totalR || 0).toFixed(2).padStart(7);
}

console.log('Hour OOS • mode=' + MODE + ' eval=' + EVAL + ' split=' + SPLIT + ' • allowlist TRAIN = jam dengan n≥' + MIN_N + ' dan avgR≥' + GOOD + '\n');
for (const pair of LIST) {
  if (!E.PAIRS[pair]) { console.log(pair, 'tidak dikenal'); continue; }
  const src = load(pair);
  if (!src) { console.log(pair, 'NO DATA'); continue; }
  const rows = src.rows, t0 = rows[0][0], t1 = rows[rows.length - 1][0];
  const split = t0 + (t1 - t0) * SPLIT;
  const shipped = (E.PAIRS[pair].hours && E.PAIRS[pair].hours.length) ? E.PAIRS[pair].hours : null;
  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + rows.length + ' tick, ' +
    ((t1 - t0) / 86400000).toFixed(1) + ' hari ' + new Date(t0).toISOString().slice(0, 10) + ' → ' + new Date(t1).toISOString().slice(0, 10) + ') ====');

  const all = runAll(pair, rows, null);
  const train = all.filter(t => t.t < split), test = all.filter(t => t.t >= split);
  const hrs = byHour(train).filter(x => x.n >= MIN_N);
  const allowTrain = hrs.filter(x => x.avgR >= GOOD).map(x => x.h).sort((a, b) => a - b);
  console.log('  jam di TRAIN (n≥' + MIN_N + '): ' + (hrs.map(x => x.h + ':' + x.avgR.toFixed(2) + '(' + x.n + ')').join(' ') || 'tidak ada'));
  console.log('  allowlist TRAIN = [' + allowTrain.join(',') + ']   shipped engine.js = [' + (shipped || []).join(',') + ']');

  const oosTrades = allowTrain.length ? runAll(pair, rows, allowTrain) : all;
  const oos = E.summarize(allowTrain.length ? oosTrades.filter(t => t.t >= split) : test);
  let ship = null;
  if (shipped && shipped.join(',') !== allowTrain.join(',')) ship = E.summarize(runAll(pair, rows, shipped).filter(t => t.t >= split));

  console.log('  TEST ' + ((t1 - split) / 86400000).toFixed(0) + ' hari:');
  console.log('   A baseline semua jam   ' + line(E.summarize(test)));
  console.log('   B allowlist dari TRAIN ' + line(oos));
  if (ship) console.log('   C shipped (dipilih in-sample) ' + line(ship));
  console.log('   — pembanding in-sample penuh (semua jam) ' + line(E.summarize(all)));
  console.log('   kekuatan statistik TEST per jam: ' + (byHour(test).map(x => x.h + ':' + x.n).join(' ') || 'kosong'));
  const verdict = (E.summarize(test).n >= 15 && oos.n >= 15)
    ? ((oos.avgR || 0) > (E.summarize(test).avgR || 0)
      ? '→ MEMBAIK di TEST (+' + ((oos.avgR || 0) - (E.summarize(test).avgR || 0)).toFixed(3) + 'R/trade)'
      : '→ MEMBURUK di TEST (' + ((oos.avgR || 0) - (E.summarize(test).avgR || 0)).toFixed(3) + 'R/trade) — jam TRAIN tidak generalisasi')
    : '→ n terlalu kecil (baseline ' + E.summarize(test).n + ', allowlist ' + oos.n + ') untuk memutuskan';
  console.log('  ' + verdict + '\n');
}
