#!/usr/bin/env node
/* ============================================================
   WALK-FORWARD BERFOLD — jawaban atas "cari parameter yang profit" tanpa menipu diri
   -------------------------------------------------------------
   backtest.js --sweep menyeleksi di TRAIN lalu menguji SEKALI di TEST. Itu sudah lebih
   jujur daripada melihat TRAIN saja, tapi satu potongan TEST = satu sampel: dari puluhan
   kombinasi, beberapa akan tampak positif cuma karena kebetulan potongan itu cocok.

   Di sini jendela bergerak maju (expanding train, test = potongan berikutnya) dan tiap
   konfigurasi dinilai dari fold TERBURUK, bukan rata-rata. Yang boleh disebut kandidat
   hanyalah yang positif di SETIAP fold dengan jumlah trade memadai.

   Pemakaian:
     node tools/walkforward.js data/EURUSDT_1m.csv --pair EURUSD [--folds 4] [--mode balanced]
                                      [--workers 6] [--eval 5000]
   Worker = pecahan grid ke proses Node terpisah (mesin pencarian sama, datanya dibagi).
   ============================================================ */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { fork } = require('child_process');
const E = require('../engine.js');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };

/* --cost-extra = slippage + komisi round-trip dalam pips (lihat backtest.js). Default 0 = hanya spread. */
const COST_EXTRA = Number(opt('cost-extra', 0)) || 0;

const GRID = [];
for (const minScore of [.45, .55, .65])
  for (const minER of [.25, .35, .45])
    for (const minCost of [2, 3, 4])
      for (const SL_ATR_MULT of [2, 3, 4])
        GRID.push({ modeOverride: { minScore, minER, minCost }, params: { SL_ATR_MULT, TP1_R: 1.0, TP2_R: 2.2, BE_AT_R: .6 } });
for (const minScore of [.45, .65])
  for (const minCost of [3, 4])
    for (const SL_ATR_MULT of [2, 4])
      for (const geo of [{ TP1_R: 1.5, TP2_R: 2.5, BE_AT_R: 0 }, { TP1_R: 2.0, TP2_R: 3.0, BE_AT_R: 0 }])
        GRID.push({ modeOverride: { minScore, minER: .35, minCost }, params: Object.assign({ SL_ATR_MULT }, geo) });

/* ---------------- mode worker: jalankan pecahan grid, cetak JSON per kombinasi ---------------- */
if (args.includes('--worker')) {
  const file = args.find(a => !a.startsWith('--') && fs.existsSync(a));
  const pair = (opt('pair', 'EURUSD') || 'EURUSD').toUpperCase();
  const baseMode = opt('mode', 'balanced');
  const FOLDS = Number(opt('folds', 4));
  const EVAL = Number(opt('eval', 5000));
  const k = Number(opt('worker', 0)), W = Number(opt('workers', 1));
  const ticks = loadTicks(file);
  const step = Math.floor(ticks.length / (FOLDS + 1));
  const folds = [];
  for (let i = 1; i <= FOLDS; i++) folds.push({ train: ticks.slice(0, i * step), test: ticks.slice(i * step, (i + 1) * step) });
  for (let i = k; i < GRID.length; i += W) {
    const g = GRID[i];
    const per = folds.map(f => ({ tr: run(pair, f.train, baseMode, g, EVAL), te: run(pair, f.test, baseMode, g, EVAL) }));
    /* writeSync: stdout anak adalah pipe dan pipe write-nya async — tanpa ini baris terakhir
       bisa hilang saat process.exit, dan kombinasi itu tidak ikut dinilai. */
    fs.writeSync(1, JSON.stringify({ i, g, per }) + '\n');
  }
  process.exit(0);
}

/* ---------------- parent: pecah grid, kumpulkan, nilai dari fold terburuk ---------------- */
function loadTicks(f) {
  const out = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split(','); if (c.length < 3) continue;
    let t = Number(c[0]); if (isNaN(t)) t = Date.parse(c[0]); else if (t < 1e11) t *= 1000;
    const b = parseFloat(c[1]), a = parseFloat(c[2]);
    if (!(t > 0 && b > 0 && a > 0 && a >= b)) continue;
    out.push([t, b, a]);
  }
  return out.sort((x, y) => x[0] - y[0]);
}
function run(pair, list, baseMode, g, evalMs) {
  const prm = Object.assign({ COST_EXTRA_PIPS: COST_EXTRA }, (g.params || {}));
  const eng = E.create(pair, Object.assign({ mode: baseMode, stale: 60000, hasFlow: false, feed: 'wf' }, g, { params: prm }));
  let lastEval = 0;
  for (const [t, b, a] of list) {
    eng.onTick(t, b, a);
    if (t - lastEval >= evalMs) { eng.evaluate(t); lastEval = t; }
  }
  return E.summarize(eng.closed.slice());
}

async function main() {
const file = args.find(a => !a.startsWith('--') && fs.existsSync(a));
if (!file) { console.log('Pemakaian: node tools/walkforward.js data/X_1m.csv --pair EURUSD [--folds 4] [--workers 6]'); process.exit(1); }
const pair = (opt('pair', 'EURUSD') || 'EURUSD').toUpperCase();
const baseMode = opt('mode', 'balanced');
const FOLDS = Number(opt('folds', 4));
const EVAL = Number(opt('eval', 5000));
const WORKERS = Math.max(1, Number(opt('workers', Math.max(1, os.cpus().length - 2))));
if (!E.PAIRS[pair]) { console.log('Pair tidak dikenal: ' + pair); process.exit(1); }
const self = process.argv[1] || __filename;

const ticks = loadTicks(file);
const days = (ticks[ticks.length - 1][0] - ticks[0][0]) / 86400000;
const step = Math.floor(ticks.length / (FOLDS + 1));
console.log('\n' + pair + ' • ' + ticks.length + ' tick • ' + days.toFixed(1) + ' hari • mode dasar ' + baseMode +
  (COST_EXTRA ? ' • biaya +' + COST_EXTRA + ' pips/trade' : '') +
  ' • ' + FOLDS + ' fold walk-forward (train = awal membesar, test = potongan berikutnya) • ' +
  GRID.length + ' kombinasi di ' + WORKERS + ' worker');
if (days < 30) console.log('⚠ Data < 30 hari: fold terlalu pendek, apa pun hasilnya belum berarti.');

const rows = [];
let done = 0;
await Promise.all(Array.from({ length: WORKERS }, (_, k) => new Promise((resolve, reject) => {
  const child = fork(self, [file, '--pair', pair, '--mode', baseMode, '--folds', String(FOLDS),
    '--eval', String(EVAL), '--cost-extra', String(COST_EXTRA), '--worker', String(k), '--workers', String(WORKERS)],
    { stdio: ['ignore', 'pipe', 'inherit', 'ipc'] });
  let buf = '';
  child.stdout.on('data', d => {
    buf += d.toString();
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
      if (!line) continue;
      const r = JSON.parse(line);
      const per = r.per.map(x => ({ tr: x.tr, te: x.te }));
      const trN = per.reduce((a, x) => a + (x.tr.n || 0), 0);
      const wTr = trN ? per.reduce((a, x) => a + x.tr.avgR * x.tr.n, 0) / trN : null;
      rows.push({ g: r.g, per, trainAvg: wTr, nTest: per.reduce((a, x) => a + x.te.n, 0),
        neg: per.filter(x => !(x.te.avgR > 0)).length,
        worst: Math.min(...per.map(x => x.te.avgR > 0 ? x.te.avgR : -Infinity)),
        aggR: per.reduce((a, x) => a + (x.te.totalR || 0), 0), aggPf: per.reduce((a, x) => a + (x.te.pf || 0), 0) / per.length });
      done++;
      if (done % 12 === 0) process.stdout.write('.');
    }
  });
  child.on('exit', c => c === 0 ? resolve() : reject(new Error('worker ' + k + ' exit ' + c)));
})));
process.stdout.write('\n');

const name = g => `score≥${g.modeOverride.minScore} ER≥${g.modeOverride.minER} ATR/biaya≥${g.modeOverride.minCost} SL=${g.params.SL_ATR_MULT}×ATR TP1=${g.params.TP1_R}R TP2=${g.params.TP2_R}R BE=${g.params.BE_AT_R ? g.params.BE_AT_R + 'R' : 'off'}`;
rows.sort((a, b) => (b.worst - a.worst) || (b.aggR - a.aggR));

console.log('\nTOP 12 diurut dari FOLD TERBURUK (bukan rata-rata):\n');
rows.slice(0, 12).forEach((r, i) => {
  console.log(`#${i + 1} ${name(r.g)}`);
  console.log(`   TRAIN ${f3(r.trainAvg)} R • TEST ${r.per.map(x => x.te.n + 'tr/' + f3(x.te.avgR)).join('  ')} → ${r.neg} fold tidak positif, agregat ${r.aggR.toFixed(2)} R, PF ${r.aggPf.toFixed(2)}`);
  if (i === 0) {
    /* Diagnosis arah-vs-geometri pada TEST (lihat summarize di engine.js): memotong pucuk profit
       tidak akan menolong kalau arangnya memang tidak informatif. */
    const n = r.per.reduce((a, x) => a + x.te.n, 0);
    if (n) {
      const w = f => (r.per.reduce((a, x) => a + (x.te[f] || 0) * x.te.n, 0) / n);
      console.log(`   pucuk profit rata-rata ${w('mfeAvg').toFixed(2)}R • rugi padahal sempat ≥1R ${Math.round(w('geoMiss') * 100)}% • rugi tanpa pernah +0,5R ${Math.round(w('dirMiss') * 100)}%`);
    }
  }
});

const ok = rows.filter(r => r.neg === 0 && r.nTest >= 30 && r.trainAvg > 0);
console.log('');
console.log(ok.length
  ? `✔ ${ok.length} konfigurasi positif di SEMUA ${FOLDS} fold (total n=${ok.map(r => r.nTest).join(', ')}). Kandidat: ${name(ok[0].g)} → agregat ${ok[0].aggR.toFixed(2)} R, PF ${ok[0].aggPf.toFixed(2)}, fold terburuk ${f3(ok[0].worst)} R.`
  : `✘ Tidak ada konfigurasi yang positif di semua ${FOLDS} fold dengan n>=30. Yang terbaik pun patah di satu potongan — itu overfit, bukan edge.`);
if (rows.length) {
  const d = rows[0];
  console.log(`   Terbaik yang ada: ${name(d.g)} → worst ${f3(d.worst)} R • agregat ${d.aggR.toFixed(2)} R • ${d.neg}/${FOLDS} fold negatif • n=${d.nTest}`);
  console.log('   Catatan: potongan test per fold ≈ ' + step + ' tick (~' + (step * (ticks[1][0] - ticks[0][0]) / 86400000).toFixed(1) +
    ' hari), jadi trade-nya sedikit; positif di satu fold dan negatif di fold lain berarti hasilnya tidak stabil.');
}
}
function f3(v){ return v == null || !isFinite(v) ? '—' : v.toFixed(3) }
main().catch(e => { console.error('STOP:', e.message); process.exit(1); });
