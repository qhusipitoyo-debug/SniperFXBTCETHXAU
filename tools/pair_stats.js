#!/usr/bin/env node
/* ============================================================
   tools/pair_stats.js — statistik winrate PER PASANGAN, offline, tanpa MT5/bridge.

   Yang dilakukan: me-replay data tick lokal lewat engine yang SAMA dengan yang dipakai
   dashboard (engine.js), untuk setiap pair × setiap mode, lalu menghitung E.summarize.
   Ini jawaban atas "apakah winrate tiap pair bagus atau jelek" tanpa perlu terminal:
   hasilnya angka model atas data, bukan angka akun broker.

   Pakai : node tools/pair_stats.js [--modes balanced,precision] [--evalms 1000] [--out stats/pair_stats.json]
   Output: JSON dibaca panel (index.html → fetch stats/pair_stats.json).

   Sumber data = data/<SYMBOL>_1m.csv, tiga kolom ts,bid,ask, dibuat tools/fetch_klines.js.
   Hanya pair yang punya angka `binance` di engine.js yang bisa diuji di mesin ini; sisanya
   dicatat sebagai TANPA DATA, bukan nol trade — supaya tidak pernah dibaca sebagai "jelek".
   ============================================================ */
const fs=require('fs');
const path=require('path');
const E=require('../engine.js');

const args=process.argv.slice(2);
const opt=(n,d)=>{const i=args.indexOf('--'+n);return i>=0&&args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:d};
const EVALMS=parseFloat(opt('evalms','1000'))||1000;
const OUT=path.resolve(__dirname,'..',opt('out','stats/pair_stats.json'));
const ROOT=path.resolve(__dirname,'..');
const MODES=(opt('modes',Object.keys(E.MODES).join(','))).split(',').map(s=>s.trim()).filter(m=>E.MODES[m]);

/* Parser identik dengan backtest.js:33-38 — header dibuang, detik dinaikkan ke ms. */
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
  return rows.sort((x,y)=>x[0]-y[0]);
}

/* Replay = sama persis dengan backtest.js:42-52: onTick per baris, evaluate tiap evalms.
   Spread sudah ada di dua kolom harga; engine menutup BUY di bid dan SELL di ask. */
function replay(pair,mode,ticks){
  const eng=E.create(pair,{mode,stale:60000,hasFlow:false,feed:'bt'});
  let lastEval=0;
  for(const [t,b,a] of ticks){
    eng.onTick(t,b,a);
    if(t-lastEval>=EVALMS){eng.evaluate(t);lastEval=t}
  }
  return eng.closed.slice();
}

const num=v=>v==null||!isFinite(v)?null:Number(v.toFixed(6));

/* Pecahan per jam UTC dari JAM MASUK sinyal (tr.t), bukan jam keluar — pertanyaannya
   "scanner ini bagus di jam berapa", dan itu soal kapan plan terkunci. Hanya jam yang
   punya trade yang disimpan; jam yang hilang berarti nol trade, bukan winrate 0%.
   n/w/g/l = jumlah, menang, R untung kotor, R rugi kotor. avgR=(g-l)/n dan PF=g/l
   diturunkan di panel, jadi tidak perlu mengulang replay untuk mengubah ambang vonis. */
function hoursOf(tr){
  const h={};
  for(const t of tr){
    if(!t.t||typeof t.resultR!=='number')continue;
    const b=h[String(new Date(t.t).getUTCHours())]||(h[String(new Date(t.t).getUTCHours())]={n:0,w:0,g:0,l:0});
    b.n++;if(t.resultR>0)b.w++;
    if(t.resultR>0)b.g+=t.resultR;else b.l-=t.resultR;
  }
  for(const k of Object.keys(h))for(const f of ['g','l'])h[k][f]=num(h[k][f]);
  return h;
}

function pack(tr){
  const s=E.summarize(tr);
  const oc={};for(const t of tr)oc[t.done]=(oc[t.done]||0)+1;
  return {n:s.n,wins:s.wins,winRate:num(s.winRate),avgR:num(s.avgR),totalR:num(s.totalR),
    pf:num(s.pf),maxDD:num(s.maxDD),winLossRatio:num(s.winLossRatio),
    mfeAvg:num(s.mfeAvg),maeAvg:num(s.maeAvg),geoMiss:num(s.geoMiss),dirMiss:num(s.dirMiss),
    upsPct:num(s.upsPct),winUp:num(s.winUp),winDown:num(s.winDown),
    holdWin:num(s.holdWin),holdLoss:num(s.holdLoss),sharpe:num(s.sharpe),smartSharpe:num(s.smartSharpe),
    outcome:oc,hours:hoursOf(tr)};
}

const pairs={},missing=[];
for(const key of Object.keys(E.PAIRS)){
  const sym=E.PAIRS[key].binance?String(E.PAIRS[key].binance).toUpperCase():null;
  const file=sym?path.join(ROOT,'data',sym+'_1m.csv'):null;
  const ticks=file&&fs.existsSync(file)?load(file):null;
  if(!ticks||ticks.length<1000){
    missing.push({pair:key,name:E.PAIRS[key].name,reason:file?('data kurang ('+(ticks?ticks.length:0)+' baris di '+path.basename(file)+') — jalankan tools/fetch_klines.js'):'tidak ada sumber data lokal untuk pair ini'});
    console.log('· '+key.padEnd(7)+' lewat  '+(missing[missing.length-1].reason));
    continue;
  }
  const modes={};
  for(const m of MODES){
    const t0=Date.now();
    modes[m]=pack(replay(key,m,ticks));
    console.log('· '+key.padEnd(7)+m.padEnd(10)+' n='+String(modes[m].n).padStart(4)+
      '  win='+((modes[m].winRate||0)*100).toFixed(1)+'%  avgR='+(modes[m].avgR==null?'—':modes[m].avgR.toFixed(3))+
      '  PF='+(modes[m].pf==null?'—':modes[m].pf.toFixed(2))+'  ('+((Date.now()-t0)/1000).toFixed(1)+'s)');
    const hr=Object.keys(modes[m].hours).map(k=>{const b=modes[m].hours[k];return{h:+k,n:b.n,a:(b.g-b.l)/b.n}})
      .filter(x=>x.n>=8).sort((x,y)=>y.a-x.a);
    if(hr.length>=4)console.log('         jam UTC terbaik '+hr[0].h+':00 ('+hr[0].a.toFixed(3)+' R, n='+hr[0].n+')  ·  terburuk '+hr[hr.length-1].h+':00 ('+hr[hr.length-1].a.toFixed(3)+' R, n='+hr[hr.length-1].n+')  ·  '+hr.length+'/24 jam punya ≥8 trade');
  }
  pairs[key]={name:E.PAIRS[key].name,symbol:sym,file:path.basename(file),rows:ticks.length,
    window:{from:ticks[0][0],to:ticks[ticks.length-1][0],days:Number(((ticks[ticks.length-1][0]-ticks[0][0])/86400000).toFixed(1))},
    modes};
}

const json={generatedAt:Date.now(),engine:{TP1_R:E.PARAMS.TP1_R,TP2_R:E.PARAMS.TP2_R,TP1_FRAC:E.PARAMS.TP1_FRAC,
  SL_ATR_MULT:E.PARAMS.SL_ATR_MULT,BE_AT_R:E.PARAMS.BE_AT_R,PLAN_TTL:E.PARAMS.PLAN_TTL,COST_EXTRA_PIPS:E.PARAMS.COST_EXTRA_PIPS||0},
  evalMs:EVALMS,modes:MODES,hoursKey:'jam UTC dari waktu masuk sinyal; tiap jam = {n:trade, w:menang, g:R untung kotor, l:R rugi kotor} — avgR=(g-l)/n, PF=g/l, winrate=w/n; jam yang tidak ada berarti nol trade',
  note:'Replay engine lokal atas tick '+Object.keys(pairs).map(k=>pairs[k].file).join(', ')+
  '. Spread broker sudah termasuk; slippage dan komisi TIDAK dimodelkan.',
  pairs,missing};
fs.mkdirSync(path.dirname(OUT),{recursive:true});
fs.writeFileSync(OUT,JSON.stringify(json));
console.log('\n→ '+path.relative(ROOT,OUT)+'  ('+(fs.statSync(OUT).size/1024).toFixed(0)+' KB, '+Object.keys(pairs).length+' pair diuji, '+missing.length+' tanpa data)');
