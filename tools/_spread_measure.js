/* tools/_spread_measure.js — ukur spread NYATA, jangan pasang angka karangan.
   Latar: gerbang biaya engine memakai costPips() = max(spread feed, PAIRS[].typSpread) + COST_EXTRA_PIPS.
   Karena max(), yang menentukan hampir selalu typSpread — asumsi "broker retail FBS-Demo" yang diwarisi
   dari catatan manual. Keputusan operator 2-11-2026: UKUR DULU, belum dipasang. File ini mencetak
   angkanya; engine.js tidak disentuh.

   SUMBER DAN MUTU INFORMASINYA (ini bagian dari hasilnya, bukan catatan kaki):
     1. korpus CSV (data/*_1m.csv) → TIDAK BERINFORMASI untuk pertanyaan ini. tools/fetch_deriv.js
        menulis bid/ask = mid ± typSpread*pip/2, jadi "spread terukur" dari file itu YA typSpread
        sendiri — sirkular. Tool ini mendeteksinya (jumlah nilai spread berbeda ≤3) dan membulatkan
        labelnya "SINTETIS". Yang tetap terbaca dari korpus: ATR, arah, keluar — bukan biaya.
     2. --live : Deriv WS publik, tick bid/ask asli, beberapa detik → spread feed yang tampil di papan
        localhost sekarang. REAL, tapi ini feed Deriv, BUKAN akun MT5 yang akan membayar tagihan.
     3. akun MT5 (FBS) → belum terukur dari mesin ini. Yang membawanya adalah sniper_status.txt dari
        EA di terminal (kolom bid/ask per simbol, poin). Sampai file itu dibaca, typSpread tetap asumsi.
   Jalan: node tools/_spread_measure.js [--live] [--detik=45] */
const fs = require('fs'), path = require('path');
const E = require('../engine.js');
const P0 = E.PARAMS;
const LIVE = process.argv.includes('--live');
const arg = (n, d) => { const f = process.argv.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d };
const SECS = Number(arg('detik', 45));
const AKUN_SECS = Number(arg('akun', 40));   // --akun=0 memblokir sampling terminal (pakai Deriv live saja)

const FILES = {
  EURUSD: 'EURUSD_1m.csv', USDJPY: 'USDJPY_1m.csv', GBPUSD: 'GBPUSD_1m.csv', USDCHF: 'USDCHF_1m.csv',
  AUDUSD: 'AUDUSD_1m.csv', USDCAD: 'USDCAD_1m.csv', NZDUSD: 'NZDUSD_1m.csv',
  XAUUSD: 'PAXGUSDT_1m.csv', BTCUSD: 'BTCUSDT_1m.csv', ETHUSD: 'ETHUSDT_1m.csv'
};
const SRC = {
  EURUSD: 'Deriv (ditulis fetch_deriv)', USDJPY: 'Deriv (ditulis fetch_deriv)', GBPUSD: 'Deriv (ditulis fetch_deriv)',
  USDCHF: 'Deriv (ditulis fetch_deriv)', AUDUSD: 'Deriv (ditulis fetch_deriv)', USDCAD: 'Deriv (ditulis fetch_deriv)',
  NZDUSD: 'Deriv (ditulis fetch_deriv)', XAUUSD: 'Binance PAXG', BTCUSD: 'Binance BTCUSDT', ETHUSD: 'Binance ETHUSDT'
};

const q = v => v.toFixed(2).padStart(6);
const pct = (a, p) => a.length ? a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))] : null;
function stats(arr) {
  const a = arr.slice().sort((x, y) => x - y), n = a.length;
  return { n, mean: a.reduce((s, x) => s + x, 0) / n, med: pct(a, .5), p75: pct(a, .75), p90: pct(a, .9), p99: pct(a, .99), min: a[0], max: a[n - 1] };
}

/* ---------- 2. live Deriv dulu, supaya tabel konsekuensi bisa ikut memakainya ---------- */
function liveSnapshot() {
  return new Promise(done => {
    if (!LIVE) return done({});
    const WS_URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
    const WSC = typeof WebSocket === 'function' ? WebSocket : require('ws');
    const keys = Object.keys(E.PAIRS).filter(k => E.PAIRS[k].deriv);
    const acc = {}; keys.forEach(k => acc[k] = []);
    const ws = new WSC(WS_URL);
    let settled = false;
    const finish = () => { if (settled) return; settled = true; try { ws.close() } catch { } done(acc) };
    ws.onopen = () => keys.forEach(k => ws.send(JSON.stringify({ ticks: E.PAIRS[k].deriv, subscribe: 1 })));
    ws.onmessage = e => {
      let j; try { j = JSON.parse(e.data) } catch { return }
      const t = j.tick; if (!t) return;
      const k = keys.find(x => E.PAIRS[x].deriv === t.symbol); if (!k) return;
      const b = +t.bid, a = +t.ask;
      if (b > 0 && a >= b) acc[k].push((a - b) / E.PAIRS[k].pip);
    };
    ws.onerror = e => { console.log('   WS gagal: ' + (e.message || e.code || 'error')); finish() };
    setTimeout(finish, SECS * 1000);
  });
}

/* ---------- 0. akun MT5: sniper_status.txt tulisan EA (bid/ask poin) ----------
   Diambil sebagai DISTRIBUSI, bukan satu kutipan: satu snapshot jam sekian bisa saja
   kebetulan sedang sempit (atau lebar). sampled() polling file secepat EA menulisnya
   (1 dtk) selama AKUN_DETIK, lalupercentilenya yang dilaporkan. */
function accountDir() {
  let B; try { B = require('../bridge/server.js') } catch (e) { return { err: 'bridge/server.js: ' + e.message } }
  const pick = B.pickFilesDir(B.discoverFilesDir());
  if (!pick.dir) return { err: 'tidak ada folder MQL5/Files di mesin ini (terminal mati?) — ketemu: ' + (pick.list || []).length };
  return { B, dir: pick.dir };
}
function accountSample(B, dir, seconds) {
  const out = {}; let n = 0, lastTs = 0, server = '', mode = '';
  const t0 = Date.now();
  while (Date.now() - t0 < seconds * 1000) {
    let st = null; try { st = B.readStatus(dir) } catch { }
    if (st && st.ts !== lastTs) {
      lastTs = st.ts; n++; server = st.server; mode = st.mode;
      for (const sym of Object.keys(st.markets)) {
        const m = st.markets[sym], pair = B.pairOfSymbol(sym), P = E.PAIRS[pair];
        if (!P || !(m.ask > 0 && m.bid > 0)) continue;
        (out[pair] = out[pair] || []).push((m.ask - m.bid) / P.pip);
      }
    }
    const until = Date.now() + Math.max(0, 250 - (Date.now() - t0) % 250);
    while (Date.now() < until) { }
  }
  return { n, server, mode, out };
}

/* sampling akun adalah busy-wait (file ditulis EA tiap detik, kita tidak bisa menunggu
   asinkron tanpa menunda laporan) — dijalankan SESUDAH snapshot WS selesai supaya tidak
   memakan event loop saat Deriv masih mengirim tick */
const ACC = accountDir();
let acct = null;
function collectAccount() {
  if (acct) return acct;
  if (ACC.err) return acct = { available: false, err: ACC.err };
  if (!AKUN_SECS) return acct = { available: false, err: 'sampling akun dimatikan (--akun=0)' };
  const s = accountSample(ACC.B, ACC.dir, AKUN_SECS);
  if (!s.n) return acct = { available: false, err: 'sniper_status.txt tidak terbaca / tidak bertambah di ' + ACC.dir };
  const med = {}, stat = {};
  for (const p of Object.keys(s.out)) { stat[p] = stats(s.out[p]); med[p] = stat[p].med }
  return acct = { available: true, dir: ACC.dir, server: s.server, mode: s.mode, n: s.n, secs: AKUN_SECS, med, stat };
}
function printAccount() {
  acct = collectAccount();
  console.log('0) AKUN MT5 (sniper_status.txt tulisan EA) — ini satu-satunya angka yang akan benar-benar dibayar:');
  if (!acct.available) console.log('   BELUM TERUKUR • ' + acct.err + '\n   → nyalakan terminal + EA, jalankan ulang tool ini. Selama baris ini kosong, typSpread = asumsi manual, bukan biaya akun.');
  else {
    console.log('   folder ' + acct.dir + '\n   server ' + acct.server + ' • trade_mode=' + acct.mode + ' • ' + acct.n + ' baris status dalam ' + acct.secs + ' detik');
    if (String(acct.mode).toLowerCase() !== 'demo') console.log('   ⚠ trade_mode bukan demo — akun ini uang NYATA. dryRun/autoArm di bridge/config.json yang menahan, bukan tool ini.');
    console.log('   pair     median   p75    p90    p99    max    n  typSpread  akun/typ  verdict');
    for (const pair of Object.keys(E.PAIRS)) {
      const st = acct.stat[pair]; if (!st) continue;
      const P = E.PAIRS[pair], r = st.med / P.typSpread;
      console.log('   ' + pair.padEnd(9) + [st.med, st.p75, st.p90, st.p99, st.max].map(q).join('') + String(st.n).padStart(6) + q(P.typSpread) + 'p' +
        '     ' + r.toFixed(2) + '×     ' +
        (r > 1.3 ? 'typSpread TERLALU LONGGAR — mesin menganggap biaya lebih murah dari kenyataannya'
          : r < .7 ? 'typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)'
            : 'cukup dekat — asumsi layak dipertahankan'));
    }
    const missing = Object.keys(E.PAIRS).filter(p => !acct.stat[p]);
    if (missing.length) console.log('   tidak muncul di Market Watch EA: ' + missing.join(', ') + ' — untuk pair ini tetap belum terukur.');
  }
  console.log('');
}

liveSnapshot().then(acc => {
  printAccount();
  const liveMed = {};
  console.log('UKUR SPREAD • costPips() = max(spread feed, typSpread) + COST_EXTRA_PIPS(' + (P0.COST_EXTRA_PIPS || 0) + ')');
  console.log('Tool ini tidak mengubah apa pun di engine.js.\n');

  if (LIVE) {
    console.log('2) LIVE Deriv WS, ' + SECS + ' dtk (' + new Date().toISOString().slice(11, 19) + ' UTC) — feed papan localhost, BUKAN akun yang membayar:');
    console.log('pair     median live  n     p90    typSpread  live/typ');
    for (const k of Object.keys(acc)) {
      const a = acc[k];
      if (!a.length) { console.log(k.padEnd(9) + '— (tak ada tick bid/ask)'); continue }
      const s = stats(a); liveMed[k] = s.med;
      console.log(k.padEnd(9) + q(s.med) + 'p  ' + String(a.length).padStart(5) + q(s.p90) + 'p  ' + q(E.PAIRS[k].typSpread) +
        '       ' + (s.med / E.PAIRS[k].typSpread).toFixed(2) + '×' + (s.med >= E.PAIRS[k].typSpread ? '  ← spread live yang menentukan biaya' : ''));
    }
    console.log('');
  }

  /* ---------- 1. korpus CSV ---------- */
  console.log('1) korpus data/*.csv — perhatikan kolom verdict: spread di file-file ini ditulis tool, bukan direkam pasar');
  console.log('pair     sumber                        n     median   p75    p90    p99    max   typ   verdict');
  const corpus = {};
  for (const pair of Object.keys(FILES)) {
    const P = E.PAIRS[pair]; if (!P) continue;
    const file = path.join(__dirname, '..', 'data', FILES[pair]);
    if (!fs.existsSync(file)) { console.log(pair.padEnd(9) + ' NO DATA ' + FILES[pair]); continue }
    const raw = fs.readFileSync(file, 'utf8').split('\n');
    const sp = [];
    for (let i = 1; i < raw.length; i++) {
      const c = raw[i].split(','); if (c.length < 3) continue;
      const b = +c[1], a2 = +c[2]; if (!(b > 0) || !(a2 >= b)) continue;
      sp.push((a2 - b) / P.pip);
    }
    if (!sp.length) continue;
    const s = stats(sp); corpus[pair] = s;
    const distinct = new Set(sp.map(x => x.toFixed(3))).size;
    const synth = distinct <= 3;
    console.log(pair.padEnd(9) + ' ' + SRC[pair].padEnd(28) + String(s.n).padStart(7) +
      [s.med, s.p75, s.p90, s.p99, s.max].map(q).join('') + q(P.typSpread) +
      '  ' + (synth ? 'SINTETIS — hanya ' + distinct + ' nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran'
        : 'terukur (' + distinct + ' nilai berbeda)'));
  }

  /* ---------- 3. konsekuensi ke gerbang biaya ---------- */
  console.log('3) apa yang berubah di gerbang ATR/biaya kalau biaya diambil dari spread yang benar-benar terukur:');
  console.log('pair     biaya sekarang  biaya terukur  minCost  butuh ATR sekarang  butuh ATR terukur  sumber');
  for (const pair of Object.keys(FILES)) {
    const P = E.PAIRS[pair], c = corpus[pair]; if (!c) continue;
    const extra = P0.COST_EXTRA_PIPS || 0;
    const mode = E.MODES.balanced, fl = (P.calib && P.calib.modeFloor) || {};
    const minCost = Math.max(mode.minCost, fl.minCost || 0);
    const now = Math.max(c.med, P.typSpread) + extra;
    const lv = (acct && acct.available ? acct.med[pair] : null) != null ? acct.med[pair] : liveMed[pair];
    const src = acct && acct.available && acct.med[pair] != null ? 'AKUN MT5' : liveMed[pair] != null ? 'Deriv live' : null;
    const inst = lv != null ? Math.max(lv, lv) + extra : null;
    console.log(pair.padEnd(9) + q(now) + 'p          ' + (inst == null ? '    ?     ' : q(inst) + 'p  ') +
      '     ' + minCost.toFixed(1) + '×  ' + q(now * minCost) + 'p          ' +
      (inst == null ? '    ?     ' : q(inst * minCost) + 'p   ') + '      ' + (src || 'belum diukur'));
  }
  console.log('\nCATATAN: angka "terukur" di atas adalah median selama ' +
    (acct && acct.available ? acct.secs + ' detik dari akun ' + acct.server : (LIVE ? SECS + ' detik feed Deriv' : 'tidak ada — jalankan --live atau biarkan --akun>0 dengan terminal hidup')) +
    '. Spread ritel melebar di rollover/berita; satu jendela pendek bukan distribusi. Kalau yang terukur JAUH di bawah typSpread,');
  console.log('         gerbang ATR/biaya kita lebih ketat dari biaya sebenarnya — itu menahan entry yang sebenarnya layak, dan itu');
  console.log('         keputusan untuk dipasang atau tidak, bukan kesimpulan yang bisa ditarik tool ini sendiri.');
});
