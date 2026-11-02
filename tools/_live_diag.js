#!/usr/bin/env node
/* Diagnosis LIVE papan scanner — menjawab "kenapa tidak ada pair lolos ENTRY/SETUP" dengan
   angka, bukan tebakan. Mengulang jalur app.js: WS Deriv publik → ticks_history untuk prefill
   → engine.evaluate() tiap few detik → cetak gerbang yang gagal per pair.
   Tidak mengubah apa pun (tidak ada ambang, tidak ada arm).
   Pemakaian: node tools/_live_diag.js [--seconds=90] [--mode=balanced] [--pairs=EURUSD,XAUUSD] */
'use strict';
const E = require('../engine.js');
const URL = 'wss://api.derivws.com/trading/v1/options/ws/public';
const arg = (n, d) => { const f = process.argv.find(a => a.startsWith('--' + n + '=')); return f ? f.split('=')[1] : d; };
const SECS = Number(arg('seconds', 90)), MODE = arg('mode', 'balanced');
const ALL = Object.keys(E.PAIRS).filter(k => E.PAIRS[k].deriv);
const PAIRS = arg('pairs', '') ? arg('pairs', '').split(',').map(s => s.toUpperCase()) : ALL;
const mode = E.MODES[MODE] || E.MODES.balanced;
const now = () => new Date();
const hhmm = () => now().toISOString().slice(11, 19);

const eng = {}, quote = {};
PAIRS.forEach(p => { eng[p] = E.create(p, { mode: MODE, stale: 30000, hasFlow: false, feed: 'deriv' }); });
console.log('diag live ' + hhmm() + ' UTC • mode=' + MODE + ' • ' + PAIRS.length + ' pair • Deriv=' + PAIRS.map(p => E.PAIRS[p].deriv).join(',')
  + '\n(minCost=' + mode.minCost + '×, minER=' + mode.minER + ', minScore=' + mode.minScore + ')\n');

const ws = new WebSocket(URL);
let seeded = 0, ticks = 0, errs = [];
ws.onopen = () => PAIRS.forEach(p => {
  const sym = E.PAIRS[p].deriv;
  ws.send(JSON.stringify({ ticks: sym, subscribe: 1 }));
  ws.send(JSON.stringify({ ticks_history: sym, adjust_start_time: 1, count: 270, end: 'latest', granularity: 60, style: 'candles' }));
});
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  if (m.error) { errs.push(m.error.code + ': ' + m.error.message); return; }
  if (m.candles && m.echo_req) {
    const p = PAIRS.find(k => E.PAIRS[k].deriv === m.echo_req.ticks_history);
    if (p) { const n = eng[p].seedBars((m.candles || []).map(c => ({ k: Math.floor(Number(c.epoch) / 60), o: +c.open, h: +c.high, l: +c.low, c: +c.close }))); seeded++; if (seeded <= 3) console.log('  prefill ' + p + ' = ' + n + ' bar'); }
    return;
  }
  const t = m.tick; if (!t) return;
  const p = PAIRS.find(k => E.PAIRS[k].deriv === t.symbol); if (!p) return;
  let bid = +t.bid, ask = +t.ask, q = +t.quote;
  if (!(bid > 0 && ask > 0)) { if (!(q > 0)) return; const half = E.PAIRS[p].pip * .4; bid = q - half; ask = q + half; }
  ticks++; quote[p] = { bid, ask, ts: t.epoch ? +t.epoch * 1000 : Date.now() };
  eng[p].onTick(quote[p].ts, bid, ask);
};
ws.onerror = e => errs.push('ws error ' + (e.message || ''));
ws.onclose = ev => console.log('  WS closed code=' + ev.code + ' reason=' + (ev.reason || '—') + ' errs=' + errs.slice(0, 3).join(' | '));

const pad = (s, n) => String(s).padEnd(n);
function report() {
  const rows = [];
  for (const p of PAIRS) {
    const P = E.PAIRS[p], q = quote[p];
    const sess = E.inSession(p, Date.now());
    const o = eng[p].evaluate(Date.now());
    const f = o.f || {};
    rows.push({ p, sess, o, f, q, age: q ? Math.round((Date.now() - q.ts) / 1000) : null });
  }
  const live = rows.filter(r => r.age != null && r.age < 30).length;
  console.log('\n' + hhmm() + ' UTC • tick diterima ' + ticks + ' • quote segar <30 dtk: ' + live + '/' + PAIRS.length +
    ' • dalam jendela sesi: ' + rows.filter(r => r.sess).length + '/' + PAIRS.length +
    ' • kandidat (countdown jalan): ' + rows.filter(r => r.o.qualified).length + '/' + PAIRS.length);
  console.log(pad('pair', 8) + pad('stage', 7) + pad('side', 6) + pad('skor', 6) + pad('ATRp', 6) + pad('spread', 8) +
    pad('ATRp/bia', 10) + pad('ER', 6) + pad('sesi', 6) + pad('kunci', 7) + 'gerbang yang gagal (soft)');
  for (const r of rows.sort((a, b) => (b.o.prog || 0) - (a.o.prog || 0) || (b.o.score || 0) - (a.o.score || 0))) {
    const f = r.f;
    const pct = r.o.persistMs ? Math.round(Math.min(1, (r.o.prog || 0) / r.o.persistMs) * 100) : 0;
    console.log(pad(r.p, 8) + pad(r.o.stage, 7) + pad(r.o.side, 6) + pad((r.o.score || 0).toFixed(2), 6) +
      pad(f.atrP != null ? f.atrP.toFixed(1) : '—', 6) + pad(f.spreadPips != null ? f.spreadPips.toFixed(1) + 'p' : '—', 8) +
      pad(f.costRatio != null ? f.costRatio.toFixed(1) + '×' : '—', 10) + pad(f.er != null ? f.er.toFixed(2) : '—', 6) +
      pad(r.sess ? 'ya' : 'TIDAK', 6) + pad((r.o.stage === 'ENTRY' ? '🔒' : pct + '%'), 7) +
      ((r.o.status === 'warming' ? 'WARMING' : String(r.o.reason || '').slice(0, 78))));
  }
  /* kenapa countdown tidak pernah sampai 100% — dibacakan dari latch engine, bukan ditebak */
  const stall = rows.filter(r => r.sess && (r.o.prog || 0) > 0 && r.o.stage !== 'ENTRY');
  if (stall.length) console.log('  → countdown berjalan tapi belum terkunci: ' +
    stall.map(r => r.p + ' ' + Math.round(Math.min(1, r.o.prog / r.o.persistMs) * 100) + '% (' + Math.ceil((r.o.persistMs - r.o.prog) / 1000) + 's lagi bila gate tidak kedip)').join(' | '));
  const worst = rows.filter(r => r.sess && r.f.costRatio != null);
  if (worst.length) {
    const need = worst.map(r => ({ p: r.p, atr: mode.minCost * r.f.cost }));
    console.log('  → butuh ATR(M15) ≥ ' + need.map(x => x.p + ' ' + x.atr.toFixed(1) + 'p').slice(0, 6).join(' | '));
  }
}
const timer = setInterval(report, 15000);
setTimeout(() => { report(); clearInterval(timer); try { ws.close() } catch {} console.log('\nselesai — tidak ada yang diubah; ini hanya pembacaan.'); process.exit(0) }, SECS * 1000);
