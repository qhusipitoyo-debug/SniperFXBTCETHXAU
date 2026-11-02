#!/usr/bin/env node
/* Uji modeFloor OUT-OF-SAMPLE — sisa pekerjaan dari log 2-11-2026 (README, bagian kalibrasi jam).
   v6 memasang calib.modeFloor per pair (XAU minScore≥.50/minER≥.33/minCost≥3.8, ETH .52/.34/4.0,
   EUR minCost 4.0). Angka itu, seperti hours[], dipilih di jendela yang sama dengannya dinilai.
   jam sudah diuji (tools/_hour_oos.js): tidak generalisasi. Alat ini menguji lantainya.

   Isolasi: floors diuji dengan hours=null supaya yang berubah hanya satu gerbang. Interaksi
   floor × allowlist sengaja TIDAK diukur di sini — di TEST keduanya menyisakan n 20-an dan
   tidak ada tenaga statistik untuk memisahkan dua filter yang ditumpuk.

   Pipeline jujur:
     1) TRAIN  : jalankan engine hidup untuk tiap kandidat floor, nilai rata-rata R di TRAIN
     2) pilih  : kandidat TERBAIK di TRAIN (syarat n minimum)  ← ini yang "dipelajari mesin"
     3) TEST   : jalankan engine hidup kandidat terpilih + baseline tanpa floor, nilai di TEST saja

   Kalau floor terpilih di TRAIN tidak mengangkat TEST, maka modeFloor shipped juga tidak punya
   dasar — dia cuma memotong sampel.

   Pakai: node tools/_floor_oos.js XAUUSD --split=0.6
          node tools/_floor_oos.js ETHUSD EURUSD
*/
const E = require('../engine.js');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opt = (n, d) => { const f = args.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const SPLIT = Number(opt('split', .6));
const EVAL = Number(opt('eval', 2000));
const MODE = opt('mode', 'balanced');
const MIN_N = Number(opt('min-n', 20));   // kandidat floor butuh sampel cukup di TRAIN supaya "terbaik" berarti
const PAIRS = args.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());
const LIST = PAIRS.length ? PAIRS : ['XAUUSD', 'ETHUSD', 'EURUSD'];

const mcfg = E.MODES[MODE] || E.MODES.balanced;
/* Kandidat floor: null = tanpa floor; shipped = apa yang ada di engine.js; lalu satu langkah lebih
   ketat dan satu langkah lebih longgar dari shipped (tiga titik, bukan grid — grid 27 kombinasi
   di 2 juta tick bukan hitungan yang jujur, itu pencarian spesifikasi). */
function candidates(pair) {
  const shipped = (E.PAIRS[pair].calib && E.PAIRS[pair].calib.modeFloor) || null;
  const out = [{ name: 'tanpa floor', floor: null }];
  if (shipped) out.push({ name: 'floor shipped', floor: shipped });
  const base = Object.assign({ minScore: mcfg.minScore, minER: mcfg.minER, minCost: mcfg.minCost }, shipped || {});
  const bump = (b, ds, de, dc) => ({
    minScore: +(b.minScore + ds).toFixed(3), minER: +(b.minER + de).toFixed(3), minCost: +(b.minCost + dc).toFixed(2)
  });
  const tight = bump(base, .02, .01, .2), loose = bump(base, -.02, -.01, -.2);
  const eq = (a, b) => ['minScore', 'minER', 'minCost'].every(k => a[k] === b[k]);
  if (!shipped || !eq(tight, shipped)) out.push({ name: 'floor +1 langkah (lebih ketat)', floor: tight });
  if (!shipped || !eq(loose, shipped)) out.push({ name: 'floor −1 langkah (lebih longgar)', floor: loose });
  return out;
}

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
/* Satu engine-run hidup. hours sengaja null; floor dipasang lewat opts.modeOverride (diterapkan
   engine SETELAH calib.modeFloor, jadi calib pair juga harus dilepas supaya baseline benar). */
function run(pair, rows, floor, fromMs) {
  const bakH = E.PAIRS[pair].hours, bakC = E.PAIRS[pair].calib;
  E.PAIRS[pair].hours = null; E.PAIRS[pair].calib = null;
  const eng = E.create(pair, { mode: MODE, modeOverride: floor || {}, stale: 60000, feed: 'bt' });
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
function line(s) {
  if (!s.n) return 'n=0'.padStart(6);
  return 'n=' + String(s.n).padStart(3) + ' wr=' + ((s.winRate || 0) * 100).toFixed(1).padStart(5) + '%' +
    ' avgR=' + (s.avgR || 0).toFixed(3).padStart(7) + ' PF=' + (s.pf == null ? '—  ' : s.pf.toFixed(2)).padStart(4) +
    ' tot=' + (s.totalR || 0).toFixed(2).padStart(7);
}
const fmt = f => f ? ['minScore', 'minER', 'minCost'].filter(k => typeof f[k] === 'number').map(k => k.slice(3).toLowerCase() + '≥' + f[k]).join(' ') : '—';

console.log('modeFloor OOS • mode=' + MODE + ' eval=' + EVAL + ' split=' + SPLIT + ' • hours=null (floor diuji sendiri, tanpa allowlist)');
console.log('kandidat floor dinilai di TRAIN dengan syarat n≥' + MIN_N + ' — kandidat di bawah ' + MIN_N + ' trade tidak boleh menang\n');
for (const pair of LIST) {
  if (!E.PAIRS[pair]) { console.log(pair, 'tidak dikenal'); continue; }
  const src = load(pair);
  if (!src) { console.log(pair, 'NO DATA'); continue; }
  const rows = src.rows, t0 = rows[0][0], t1 = rows[rows.length - 1][0], split = t0 + (t1 - t0) * SPLIT;
  console.log('==== ' + pair + ' (' + path.basename(src.file) + ', ' + rows.length + ' tick, ' +
    ((t1 - t0) / 86400000).toFixed(1) + ' hari) shipped floor = ' + fmt((E.PAIRS[pair].calib || {}).modeFloor) + ' ====');

  const cands = candidates(pair);
  const train = cands.map(c => {
    const s = E.summarize(run(pair, rows, c.floor, null).filter(t => t.t < split));
    console.log('   TRAIN ' + c.name.padEnd(28) + line(s) + '   ' + fmt(c.floor));
    return { ...c, s };
  });
  const eligible = train.filter(c => c.s.n >= MIN_N);
  const pick = eligible.sort((a, b) => (b.s.avgR || 0) - (a.s.avgR || 0))[0];
  console.log('   → dipilih di TRAIN: ' + (pick ? pick.name + '  ' + fmt(pick.floor) : 'TIDAK ADA kandidat dengan n≥' + MIN_N));

  const base = E.summarize(run(pair, rows, null, split).filter(t => t.t >= split));
  console.log('   TEST baseline tanpa floor ' + line(base));
  if (pick) {
    const t = E.summarize(run(pair, rows, pick.floor, split).filter(x => x.t >= split));
    console.log('   TEST floor terpilih TRAIN ' + line(t) + '  ΔavgR ' + ((t.avgR || 0) - (base.avgR || 0)).toFixed(3) + 'R/trade');
    const powered = t.n >= MIN_N && base.n >= MIN_N;
    let verdict;
    if (!powered) verdict = '→ TIDAK PUTUSKAN (TEST n=' + base.n + ' vs ' + t.n + ', butuh ≥' + MIN_N +
      ' dua-duanya). Yang tetap terbukti: floor ini MEMOTONG sampel tanpa bukti manfaat.';
    else if ((t.avgR || 0) > (base.avgR || 0)) verdict = '→ floor MENGANGKAT TEST — kandidat ini lolos uji keluar-sampel';
    else verdict = '→ floor TIDAK mengangkat TEST — sama seperti jam, lantai ini hasil in-sample';
    console.log('   ' + verdict);
    if (powered && pick.name.indexOf('shipped') < 0) console.log('   Catatan: yang menang di TRAIN adalah ' + pick.name + ', bukan shipped.');
  }
  const shippedC = train.find(c => c.name === 'floor shipped');
  if (shippedC) {
    const t = E.summarize(run(pair, rows, shippedC.floor, split).filter(x => x.t >= split));
    console.log('   TEST floor shipped (in-sample) ' + line(t));
  }
  console.log('');
}
