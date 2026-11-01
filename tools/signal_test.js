#!/usr/bin/env node
/* ============================================================
   SIGNAL TEST — apakah SINYAL ARAH itu sendiri membawa informasi?
   -------------------------------------------------------------
   Konsep dipinjam dari jesse-ai/jesse (MIT): Strategy._execute_for_signal_test()
   menjalankan should_long()/should_short() TANPA mensimulasikan posisi, lalu menilai
   tiap sinyal dengan return maju yang di-detrend, dan membangun distribusi nol lewat
   stationary block bootstrap. Itu jawaban atas pertanyaan yang tidak bisa dijawab
   backtest biasa: kalau avgR negatif, yang salah entry atau exit?

   Di proyek ini pertanyaannya sudah setengah terjawab: geoMiss = 0% (tidak ada trade
   rugi yang sempat +1R) artinya exit bukan penyebab. Alat ini menutup sisinya —
   dia tidak menyentuh SL/TP/BE/time-stop sama sekali, hanya "mesin bilang UP/DOWN,
   lalu harga bergerak ke mana beberapa menit kemudian".

   Pemakaian:
     node tools/signal_test.js data/EURUSDT_1m.csv --pair EURUSD [--mode balanced]
          [--horizon 15]        jendela prediksi, menit
          [--stride 15]         jarak antar sampel, menit (== horizon → jendela tidak tumpang tindih)
          [--eval 60000]        interval evaluate(), ms
          [--cost-extra 0]      pips round-trip tambahan; hanya mengubah angka "bersih biaya"
          [--boot 3000]         jumlah ulangan bootstrap
          [--seed 7]            agar bisa direproduksi
   Baca hasilnya: p ≥ 0,05 = arah tidak bisa dibedakan dari nol. Tidak ada gunanya
   menyetel SL/TP/kost lagi di atas sinyal yang begitu — itu cuma memindah-mindahkan rugi.
   ============================================================ */
'use strict';
const fs = require('fs');
const E = require('../engine.js');

const args = process.argv.slice(2);
const file = args.find(a => !a.startsWith('--') && fs.existsSync(a));
const opt = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const num = (n, d) => Number(opt(n, d)) || d;
if (!file) { console.log('Pemakaian: node tools/signal_test.js ticks.csv --pair EURUSD [--mode balanced] [--horizon 15] [--boot 3000]'); process.exit(1); }

const pair = (opt('pair', 'EURUSD') || 'EURUSD').toUpperCase();
const modeName = opt('mode', 'balanced');
const H_MIN = num('horizon', 15), STRIDE_MIN = num('stride', H_MIN);
const EVAL = num('eval', 60000), BOOT = num('boot', 3000), SEED = num('seed', 7);
const COST_EXTRA = num('cost-extra', 0);
if (!E.PAIRS[pair]) { console.log('Pair tidak dikenal: ' + pair); process.exit(1); }
const P = E.PAIRS[pair], prm = E.PARAMS;

const modeOverride = {};
for (const k of ['minScore', 'minER', 'minCost']) { const v = opt(k); if (v != null) modeOverride[k] = parseFloat(v); }
const mode = Object.assign({}, E.MODES[modeName] || E.MODES.balanced, modeOverride);

/* ---------------- data ---------------- */
function load(f) {
  const rows = [];
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    const c = line.split(','); if (c.length < 3) continue;
    let t = Number(c[0]); if (isNaN(t)) t = Date.parse(c[0]); else if (t < 1e11) t *= 1000;
    const b = parseFloat(c[1]), a = parseFloat(c[2]);
    if (!(t > 0 && b > 0 && a >= b)) continue;
    rows.push([t, b, a]);
  }
  rows.sort((x, y) => x[0] - y[0]); return rows;
}
const ticks = load(file);
const TS = ticks.map(x => x[0]);
/* harga di suatu waktu = tick terakhir yang tidak melewati waktu itu (praktis = tengah-tengah
   spread 15 detik lalu). Cari dengan biner supaya tidak O(n²). */
function idxAt(t) {
  let lo = 0, hi = TS.length - 1, r = -1;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (TS[m] <= t) { r = m; lo = m + 1 } else hi = m - 1 }
  return r;
}

/* ---------------- rekam sinyal (tanpa posisi, tanpa exit) ---------------- */
const eng = E.create(pair, { mode: modeName, modeOverride, stale: 60000, hasFlow: false, feed: 'bt', params: Object.assign({ COST_EXTRA_PIPS: COST_EXTRA }, {}) });
const sig = [];
let lastEval = 0;
for (const [t, b, a] of ticks) {
  eng.onTick(t, b, a);
  if (t - lastEval >= EVAL) {
    lastEval = t;
    const o = eng.evaluate(t);
    if (o.status === 'ok' && (o.side === 'UP' || o.side === 'DOWN'))
      sig.push({ t, d: o.side === 'UP' ? 1 : -1, score: o.score, f: o.f });
  }
}

const H = H_MIN * 60000, STRIDE = STRIDE_MIN * 60000;
const strideIdx = Math.max(1, Math.round(STRIDE / EVAL));
const samples = [];
for (let i = 0; i < sig.length; i += strideIdx) {
  const s = sig[i], j0 = idxAt(s.t), j1 = idxAt(s.t + H);
  if (j0 < 0 || j1 < 0 || j1 <= j0 || TS[j1] < s.t + H - 3 * EVAL) continue;   // Data berakhir / tidak ada tick di ujung jendela.
  const [b0, a0] = [ticks[j0][1], ticks[j0][2]], [b1, a1] = [ticks[j1][1], ticks[j1][2]];
  const mid0 = (a0 + b0) / 2;
  const atrFrac = (s.f.atrP * P.pip) / mid0;
  if (!(atrFrac > 0)) continue;
  /* Return yang disimpan adalah PERUBAHAN HARGA (mid→mid), bukan hasil trade, dan dikali d
     belakangan. Urutannya penting: detrend dulu (buang drift aset), baru kalikan arah.
   Sisi bersih = masuk di sisi yang benar, keluar di sisi lawan, jadi spread data terhitung. */
  const lg = Math.log(((a1 + b1) / 2) / mid0);
  const entry = s.d > 0 ? a0 : b0, exit = s.d > 0 ? b1 : a1;
  const ln = Math.log(exit / entry);
  samples.push({ t: s.t, d: s.d, score: s.score, f: s.f, atrFrac, rGross: lg, rNet: ln });
}

/* Detrend global SATU kali untuk semua sampel. Kalau rata-ratanya dihitung per subset,
   subset satu sisi (hanya UP / hanya DOWN) jadi nol persis dan tidak bisa diuji. */
const MU = samples.length ? samples.reduce((a, s) => a + s.rGross, 0) / samples.length : 0;

/* ---------- statistik: edge dalam satuan ATR, terhadap nol yang sudah dibuang driftnya ---------- */
function values(list) { return list.map(s => (s.rGross - MU) / s.atrFrac); }
function edge(list) {
  const n = list.length; if (!n) return null;
  const v = values(list);
  const obs = v.reduce((a, x, i) => a + list[i].d * x, 0) / n;
  const wsum = list.reduce((a, s) => a + Math.abs(s.score), 0);
  const obsW = wsum ? list.reduce((a, s, i) => a + s.d * s.score * v[i], 0) / wsum : null;
  const mu = v.reduce((a, x) => a + x, 0) / n;
  return { n, obs, obsW, sd: Math.sqrt(v.reduce((a, x) => a + (x - mu) ** 2, 0) / n) };
}
/* Drag biaya = berapa ATR yang hilang cuma karena spread, dihitung di konvensi trade
   (selalu dikali arah, jadi selalu negatif — kalau tidak dikali, UP dan DOWN saling menghapus).
   SENGAJA tidak di-bootstrap: spread bukan sinyal, dia rugi pasti. Yang diuji hanya apakah
   ARahnya punya informasi; sisanya aritmetika: edge kotor − drag = sisa setelah biaya. */
function drag(list) { if (!list.length) return null; return list.reduce((a, s) => a + s.d * (s.rNet - s.rGross) / s.atrFrac, 0) / list.length; }
/* Drag biaya = selisih bersih vs kotor, dalam ATR. SENGAJA tidak ikut di-bootstrap:
   spread bukan sinyal, dia rugi pasti yang besarnya berbeda-beda per sampel justru karena
   berkorelasi dengan kondisi pasar — kalau diuji signifikansi, bootstrap akan "menemukan"
   bahwa biaya itu nyata (p≈0) dan itu bukan pertanyaan yang sedang dijawab. Jawabannya cuma:
   edge kotor − drag = apakah setelah biaya masih ada yang tersisa. */

/* ---------- nol: stationary block bootstrap (Politis–Romano) pada seri return ---------- */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296 }; }
function bootstrap(list, L, B, seed) {
  const st = edge(list); if (!st || st.n < 20) return null;
  const n = st.n, v = values(list), d = list.map(s => s.d);
  const rnd = mulberry32(seed), p = 1 / L, out = [];
  for (let b = 0; b < B; b++) {
    /* Arah d dibiarkan pada posisinya; hanya seri return yang di-resample per blok
       (panjang blok geometris, rata-rata L) supaya korelasi serial return tetap utuh.
       Kalau return di-shuffle per-sampel, nol-nya terlalu galak dan edge asli bisa tertelan. */
    let s = 0, i = Math.floor(rnd() * n);
    for (let k = 0; k < n; k++) {
      s += d[k] * v[i];
      if (rnd() < p) i = Math.floor(rnd() * n); else i = (i + 1) % n;
    }
    out.push(s / n);
  }
  out.sort((a, c) => a - c);
  const q = x => out[Math.min(out.length - 1, Math.max(0, Math.floor(x * out.length)))];
  let bm = 0; for (const x of out) bm += x; bm /= out.length;
  let bv = 0; for (const x of out) bv += (x - bm) ** 2; bv = Math.sqrt(bv / out.length);
  const ge = Math.abs(st.obs), two = out.filter(x => Math.abs(x) >= ge).length / out.length;
  return { ...st, nullMean: bm, nullSd: bv, p2: two, p1: st.obs >= 0 ? out.filter(x => x >= ge).length / out.length : out.filter(x => x <= -ge).length / out.length, lo: q(.025), hi: q(.975), z: bv > 0 ? (st.obs - bm) / bv : null };
}

/* ---------- gerbang, direkonstruksi dari rekaman fitur (untuk ablation) ---------- */
const GATES = [
  ['ATR/biaya', (s) => s.f.costRatio >= mode.minCost],
  ['ER (choppy)', (s) => s.f.er >= mode.minER],
  ['Skor', (s) => Math.abs(s.score) >= mode.minScore],
  ['Mom&trend searah', (s) => Math.sign(s.f.mom) === s.d && Math.sign(s.f.trend) === s.d],
  ['Mom&trend cukup', (s) => Math.abs(s.f.mom) >= prm.MIN_MOM && Math.abs(s.f.trend) >= prm.MIN_TREND],
  ['HTF tidak lawan', (s) => s.f.htf * s.d >= prm.HTF_SOFT],
  ['Brk floor', (s) => s.f.brk >= prm.BRK_FLOOR],
  ['Brk ceil', (s) => s.f.brk <= prm.BRK_CEIL],
  ['Flow tidak lawan', (s) => !mode.needFlow || !s.f.flowOK || Math.sign(s.f.flow) === s.d || Math.abs(s.f.flow) < .1],
  ['z jangan kejar', (s) => s.f.z60d <= prm.MAX_Z60 && s.f.z180d <= prm.MAX_Z180],
  ['retrace', (s) => s.f.retrace <= prm.MAX_RETRACE_ATR],
  ['SL swing valid', (s) => !s.f.slTooFar],
  ['spread', (s) => s.f.spreadPips <= P.maxSpread],
  ['spike volatilitas', (s) => s.f.volRatio <= prm.SPIKE_MAX]
];
const passAll = (s, skip) => GATES.every(([k, f], i) => i === skip || f(s));

/* ---------------- cetak ---------------- */
const f3 = v => v == null || !isFinite(v) ? '—' : v.toFixed(3);
const pc = v => v == null ? '—' : (100 * v).toFixed(1) + '%';
function verdict(x) {
  if (!x) return 'n terlalu kecil (<20)';
  const sig = x.p2 < .05;
  return (sig ? '✔ sinyal TERBEDA dari nol (p=' + x.p2.toFixed(3) + ')'
    : '✘ sinyal TIDAK terbedakan dari nol (p=' + x.p2.toFixed(3) + ')')
    + ' • edge ' + f3(x.obs) + ' ATR • selang nol 95% [' + f3(x.lo) + ', ' + f3(x.hi) + ']';
}
const L = num('blocklen', 10);
function report(label, list, off) {
  const st = bootstrap(list, L, BOOT, SEED + off);
  if (!st) { console.log('   ' + label + 'n=' + list.length + ' • terlalu sedikit (<20)'); return null }
  const dr = drag(list);
  console.log('   ' + label + 'n=' + st.n + ' • ' + verdict(st));
  console.log('     edge kotor ' + f3(st.obs) + ' ATR  −  drag spread ' + f3(dr) + ' ATR  =  setelah biaya ' + f3(st.obs + dr) + ' ATR');
  return st;
}
const days = (TS[TS.length - 1] - TS[0]) / 86400000;
console.log('\nsignal_test ' + pair + ' • ' + ticks.length + ' tick • ' + days.toFixed(1) + ' hari • mode ' + modeName +
  ' • jendela ' + H_MIN + ' mnt • stride ' + STRIDE_MIN + ' mnt • bootstrap ' + BOOT + ' (L=' + L + ', seed ' + SEED + ')' +
  (COST_EXTRA ? ' • biaya +' + COST_EXTRA + ' pips' : ''));
console.log('  eval mesin      : ' + sig.length + ' → ' + samples.length + ' sampel tidak tumpang tindih');

console.log('\nA. SEMUA sinyal arah, tanpa gerbang apa pun (pertanyaan inti: adakah informasi arah?)');
const g = report('', samples, 0);
if (g) console.log('     tertimbang skor  : ' + f3(g.obsW) + ' ATR (sinyal kuat dianggap lebih percaya)');

const setAll = samples.filter(s => passAll(s, -1));
console.log('\nB. Sinyal yang LOLOS SEMUA gerbang (ini yang boleh jadi trade)');
report('', setAll, 2);

console.log('\nC. ABLATION gerbang — apa yang terjadi kalau satu gerbang DIBUANG (konsep filters() jesse, diuji terbalik)');
console.log('   gerbang yang berguna = edge naik saat dia dipakai. Kalau justru naik saat dibuang, dia menghalangi sinyal bagus.');
console.log('   "hilang" = jumlah sampel kalau gerbang itu dilonggarkan; kalau sama dengan "n lolos", gerbang itu tidak pernah menolak apa pun di sini.\n');
console.log('   ' + 'gerbang'.padEnd(20) + 'n lolos'.padStart(8) + 'hilang'.padStart(8) + 'edge+gerbang'.padStart(15) + 'edge−gerbang'.padStart(15) + '   Δ');
const rows = GATES.map(([k], i) => {
  const with_ = samples.filter(s => passAll(s, -1)), without_ = samples.filter(s => passAll(s, i));
  const a = edge(with_), b = edge(without_);
  return { k, nw: with_.length, wo: without_.length, aw: a && a.obs, bw: b && b.obs, d: (a && b) ? b.obs - a.obs : null };
});
rows.sort((x, y) => (y.d == null ? -9 : y.d) - (x.d == null ? -9 : x.d));
rows.forEach(r => console.log('   ' + r.k.padEnd(20) + String(r.nw).padStart(8) + String(r.wo).padStart(8) +
  '        ' + f3(r.aw) + '        ' + f3(r.bw) + '  ' + (r.d == null ? ' —' : (r.d >= 0 ? '+' : '') + r.d.toFixed(3))));

const up = samples.filter(s => s.d > 0), dn = samples.filter(s => s.d < 0);
console.log('\nD. Per sisi (asimetri arah — mesin ini pernah terbukti lebih mudah bilang UP)');
report('UP   ', up, 4); report('DOWN ', dn, 5);

console.log('\nE. KONTROL ALAT (uji dirinya sendiri, supaya "✘ tidak signifikan" di atas bisa dipercaya)');
report('nabi    ', samples.map(s => ({ ...s, d: (s.rGross - MU) >= 0 ? 1 : -1 })), 6);
const rnd = mulberry32(99); report('koin    ', samples.map(s => ({ ...s, d: rnd() < .5 ? 1 : -1 })), 7);

if (samples.length < 50) console.log('\n⚠ Sampel < 50: jangan putuskan apa pun dari angka di atas, perbesar --horizon atau datanya.');
