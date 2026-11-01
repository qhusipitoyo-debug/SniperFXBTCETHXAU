#!/usr/bin/env node
/* ============================================================
   FX SNIPER — BACKTEST / KALIBRASI OFFLINE (memakai engine.js yang sama dengan app live)

   Input : CSV tick  ->  ts,bid,ask   (ts = epoch ms, epoch detik, atau ISO8601; header opsional)
           Bisa dari tombol "Export ticks" di app, atau data tick historis (mis. Dukascopy -> konversi ke 3 kolom ini).
   Pakai : node backtest.js ticks.csv --pair EURUSD [--mode precision] [--sweep] [--split 0.6] [--feed oanda]
   Output: statistik R (expectancy, profit factor, max drawdown), breakdown per jam UTC,
           dan (--sweep) grid parameter dengan seleksi di data TRAIN lalu validasi di data TEST.

   PENTING: parameter terbaik di TRAIN yang jelek di TEST = overfit. Hanya percaya yang bertahan di TEST,
   dengan >= 30 trade, dan idealnya di beberapa minggu data berbeda.
   ============================================================ */
const fs=require('fs');
const E=require('./engine.js');

const args=process.argv.slice(2);
const file=args.find(a=>!a.startsWith('--')&&!Object.keys(E.PAIRS).includes(a)&&fs.existsSync(a));
const opt=(n,d)=>{const i=args.indexOf('--'+n);return i>=0&&args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:d};
const flag=n=>args.includes('--'+n);
if(!file){console.log('Pemakaian: node backtest.js ticks.csv --pair EURUSD [--mode precision] [--sweep] [--split 0.6] [--cost-extra 1.5]');process.exit(1)}
const pair=(opt('pair','EURUSD')||'EURUSD').toUpperCase(),mode=opt('mode','precision'),split=parseFloat(opt('split','0.6'));
/* --cost-extra = slippage + komisi ROUND-TRIP dalam pips. Spread sudah ada di data; ini yang tidak ada.
   Isi sesuai akunmu: akun standar -> ±0 (spread-nya sudah markup), akun raw/ECN -> komisi per lot dibagi
   nilai pip per lot, misalnya $3/lot di EURUSD (nilai pip $10/lot) = 0,3 pips, plus slippage 0,3-0,5. */
const costExtra=parseFloat(opt('cost-extra','0'))||0;
if(!E.PAIRS[pair]){console.log('Pair tidak dikenal');process.exit(1)}

function load(f){
  const rows=[];
  for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){
    if(!line.trim())continue;
    const c=line.split(',');if(c.length<3)continue;
    let t=Number(c[0]);if(isNaN(t))t=Date.parse(c[0]);else if(t<1e11)t*=1000;
    const b=parseFloat(c[1]),a=parseFloat(c[2]);
    if(!(t>0&&b>0&&a>0&&a>=b))continue;
    rows.push([t,b,a]);
  }
  rows.sort((x,y)=>x[0]-y[0]);return rows;
}

function run(ticks,o,evalMs){
  evalMs=evalMs||1000;
  const prm=Object.assign({COST_EXTRA_PIPS:costExtra},(o&&o.params)||{});
  const eng=E.create(pair,Object.assign({mode,stale:60000,hasFlow:false,feed:'bt'},o||{},{params:prm}));
  let lastEval=0;
  for(const [t,b,a] of ticks){
    eng.onTick(t,b,a);
    if(t-lastEval>=evalMs){eng.evaluate(t);lastEval=t}
  }
  return eng.closed.slice();
}
const f2=(v,d=2)=>v==null?'—':(v===Infinity?'∞':v.toFixed(d));
const pct=v=>v==null?'—':(v*100).toFixed(1)+'%';
function line(s){return `n=${String(s.n).padStart(4)}  win=${s.winRate==null?'  —  ':(s.winRate*100).toFixed(1).padStart(5)+'%'}  avgR=${f2(s.avgR,3).padStart(7)}  totalR=${f2(s.totalR).padStart(7)}  PF=${f2(s.pf).padStart(5)}  maxDD=${f2(s.maxDD).padStart(5)}R`}
/* Diagnosis MFE/MAE: memisahkan "salah arah" dari "salah keluar". Angka-angkanya dalam R (jarak SL = 1R). */
function diag(tr){
  const s=E.summarize(tr);
  if(s.mfeAvg==null)return '  (tidak ada jejak MFE/MAE)';
  const out=[];
  out.push(`  puncak profit rata-rata ${f2(s.mfeAvg,2)}R • puncak rugi rata-rata ${f2(s.maeAvg,2)}R`);
  out.push(`  rugi padahal sudah pernah ≥1,0R: ${(s.geoMiss*100).toFixed(0)}%  → kalau besar, yang salah GEOMETRI keluar (TP/BE/time-stop), bukan sinyalnya`);
  out.push(`  rugi tanpa pernah sampai +0,5R: ${(s.dirMiss*100).toFixed(0)}%  → kalau besar, yang salah ARAH/filter masuknya`);
  const g={};for(const t of tr){(g[t.done]=g[t.done]||[]).push(t)}
  for(const k of Object.keys(g).sort((a,b)=>g[b].length-g[a].length)){
    const q=E.summarize(g[k]);
    out.push(`  ${k.padEnd(5)} n=${String(q.n).padStart(3)}  avgR=${f2(q.avgR,3).padStart(7)}  mfe=${f2(q.mfeAvg,2).padStart(5)}R  mae=${f2(q.maeAvg,2).padStart(6)}R`);
  }
  return out.join('\n');
}
/* Ukuran tambahan, konsepnya dipinjam dari jesse (services/metrics.py): semuanya sengaja
   TIDAK bergantung pada rata-rata R, supaya tidak bisa dimanipulasi dengan menutup mata
   pada satu trade besar. smart-Sharpe menghukum Sharpe yang tingginya cuma karena trade
   saling berdempetan; rasio tahan menguji bias "potong laba, tahan rugi". */
function extra(tr){
  const s=E.summarize(tr);const out=[];
  if(s.winLossRatio!=null||s.holdWin!=null||s.sharpe!=null){
    out.push(`  rata-rata menang : rata-rata rugi = ${f2(s.winLossRatio,2)} : 1  (PF ${(s.pf===Infinity?'∞':f2(s.pf,2))} = win-rate × rasio ini)`);
    out.push(`  arah: ${s.upsPct==null?'—':(s.upsPct*100).toFixed(0)+'% UP'} • win UP ${pct(s.winUp)} vs win DOWN ${pct(s.winDown)}`);
    if(s.holdWin!=null&&s.holdLoss!=null)out.push(`  durasi tahan: menang ${f2(s.holdWin,0)} mnt vs rugi ${f2(s.holdLoss,0)} mnt → rasio ${f2(s.holdWin/s.holdLoss,2)} (>1 = rugi ditahan lebih lama)`);
    if(s.sharpe!=null)out.push(`  Sharpe per-trade ${f2(s.sharpe,3)} • smart-Sharpe ${f2(s.smartSharpe,3)} (hukuman korelasi serial ${(s.smartSharpe?s.sharpe/s.smartSharpe:null)==null?'—':f2(s.sharpe/s.smartSharpe,2)}×)`);
  }
  return out.join('\n')||'  (butuh ≥1 trade)';
}
function byHour(list){
  const h={};for(const t of list){const k=new Date(t.t).getUTCHours();(h[k]=h[k]||[]).push(t)}
  return Object.keys(h).map(Number).sort((a,b)=>a-b).map(k=>`  ${String(k).padStart(2)}:00 UTC  ${line(E.summarize(h[k]))}`).join('\n');
}

const ticks=load(file);
if(ticks.length<1000){console.log('Data terlalu sedikit ('+ticks.length+' tick).');process.exit(1)}
const days=(ticks[ticks.length-1][0]-ticks[0][0])/86400000;
console.log(`\n${ticks.length} tick • ${days.toFixed(1)} hari • ${pair} • mode ${mode}` + (costExtra?` • biaya +${costExtra} pips/trade`:''));
if(days<10)console.log('⚠ Data < 10 hari: statistik sangat tidak stabil. Idealnya >= 4–8 minggu.');

if(!flag('sweep')){
  const tr=run(ticks);
  console.log('\nHASIL (semua data):\n  '+line(E.summarize(tr)));
  console.log('\nDiagnosis MFE/MAE:\n'+diag(tr));
  console.log('\nUkuran kualitas (tidak bergantung rata-rata R):\n'+extra(tr));
  console.log('\nPer jam entry (UTC):\n'+(byHour(tr)||'  (tidak ada trade)'));
  const oc={};tr.forEach(t=>oc[t.done]=(oc[t.done]||0)+1);console.log('\nOutcome:',oc);
  console.log(costExtra
    ?`\nBiaya: spread dari data (BUY keluar di bid, SELL keluar di ask) + ${costExtra} pips slippage/komisi round-trip, dihitung sekali per trade dan ikut menekan avgR. Slippage tetap tidak mengenal kondisi market.`
    :'\nBiaya sudah termasuk spread dari data (BUY keluar di bid, SELL keluar di ask). Slippage/komisi broker TIDAK dimodelkan — kurangi hasil sedikit, atau ulangi dengan --cost-extra <pips>.');
  process.exit(0);
}

/* ---------- sweep walk-forward ---------- */
const cut=ticks[Math.floor(ticks.length*split)][0];
const train=ticks.filter(r=>r[0]<cut),test=ticks.filter(r=>r[0]>=cut);
const grid=[];
for(const minScore of [.45,.55,.65])for(const minER of [.25,.35,.45])for(const minCost of [2,3,4])for(const sl of [2,3,4])
  grid.push({modeOverride:{minScore,minER,minCost},params:{SL_ATR_MULT:sl}});
console.log(`\nSweep ${grid.length} kombinasi • TRAIN ${train.length} tick • TEST ${test.length} tick (split ${split})\n(evaluasi tiap 5 detik agar cepat; bisa beberapa menit...)\n`);
const res=[];
grid.forEach((g,i)=>{
  const a=E.summarize(run(train,g,5000));if(a.n<20)return;          // abaikan konfigurasi dengan sampel terlalu kecil
  res.push({g,a,b:E.summarize(run(test,g,5000))});
  if((i+1)%20===0)process.stdout.write('.');
});
console.log('\n');
res.sort((x,y)=>y.a.avgR-x.a.avgR);
const name=g=>`score≥${g.modeOverride.minScore} ER≥${g.modeOverride.minER} ATR/biaya≥${g.modeOverride.minCost} SL=${g.params.SL_ATR_MULT}×ATR`;
console.log('TOP 8 di TRAIN, dengan hasil TEST di bawahnya:\n');
res.slice(0,8).forEach((r,i)=>{console.log(`#${i+1} ${name(r.g)}\n   TRAIN ${line(r.a)}\n   TEST  ${line(r.b)}\n`)});
const robust=res.filter(r=>r.a.avgR>0&&r.b.n>=30&&r.b.avgR>0&&r.b.pf>1.1);
console.log(robust.length
  ?`✔ ${robust.length} konfigurasi positif di TRAIN dan TEST (n_test>=30, PF>1.1). Pilih yang parameternya berada di "plateau" (tetangganya juga positif), bukan satu puncak tunggal.`
  :'✘ Tidak ada konfigurasi yang positif di TRAIN dan TEST dengan sampel memadai. Artinya: pada data ini tidak ada bukti edge — jangan dipakai dengan uang nyata.');
