#!/usr/bin/env node
/* Probe jam UTC + usulan allowlist untuk major FX (data/<PAIR>_1m.csv dari Deriv). */
const E=require('../engine.js');
const fs=require('fs');
const path=require('path');

const PAIRS=process.argv.slice(2).filter(a=>!a.startsWith('--'));
const keys=PAIRS.length?PAIRS:['EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD'];
const EVAL=2000;
const MIN_N=6;          // jam dengan n trade cukup untuk dinilai
const GOOD_AVGR=0.02;   // ambang jam "bagus"
const BAD_AVGR=-0.01;   // ambang jam "jelek"

function load(pair){
  const cands=[
    E.PAIRS[pair].binance&&path.join(__dirname,'../data',String(E.PAIRS[pair].binance).toUpperCase()+'_1m.csv'),
    path.join(__dirname,'../data',pair+'_1m.csv')
  ].filter(Boolean);
  for(const f of cands){
    if(!fs.existsSync(f))continue;
    const rows=[];
    for(const line of fs.readFileSync(f,'utf8').split(/\n/)){
      const c=line.split(',');if(c.length<3)continue;
      const t=Number(c[0]),b=Number(c[1]),a=Number(c[2]);
      if(t&&b>0&&a>=b)rows.push([t,b,a]);
    }
    if(rows.length>=1000)return {file:f,rows};
  }
  return null;
}
function run(pair,ticks,mode,hoursOverride){
  const bak=E.PAIRS[pair].hours;
  if(hoursOverride)E.PAIRS[pair].hours=hoursOverride;
  const eng=E.create(pair,{mode,stale:60000,feed:'bt'});
  let last=0;
  for(const [t,b,a] of ticks){eng.onTick(t,b,a);if(t-last>=EVAL){eng.evaluate(t);last=t}}
  E.PAIRS[pair].hours=bak;
  return eng.closed.slice();
}
function summarizeHours(closed){
  const h={};
  for(const t of closed){
    if(typeof t.resultR!=='number'||!t.t)continue;
    const k=new Date(t.t).getUTCHours();
    const b=h[k]||(h[k]={n:0,w:0,g:0,l:0});
    b.n++;if(t.resultR>0){b.w++;b.g+=t.resultR}else b.l-=t.resultR;
  }
  return Object.keys(h).map(Number).sort((a,b)=>a-b).map(k=>{
    const b=h[k];return{h:k,n:b.n,wr:b.w/b.n,avgR:(b.g-b.l)/b.n,pf:b.l>0?b.g/b.l:null,tot:b.g-b.l};
  });
}
function f(s){
  if(!s.n)return 'n=0';
  return 'n='+s.n+' wr='+((s.winRate||0)*100).toFixed(1)+'% avgR='+(s.avgR||0).toFixed(3)+
    ' PF='+(s.pf==null?'—':s.pf.toFixed(2))+' tot='+(s.totalR||0).toFixed(2);
}

console.log('FX hour calib • evalMs='+EVAL+'\n');
for(const pair of keys){
  if(!E.PAIRS[pair]){console.log(pair,'tidak dikenal');continue}
  const src=load(pair);
  if(!src){console.log(pair,'NO DATA');continue}
  // Baseline: paksa semua jam 0-23 supaya breakdown lengkap (lewati allowlist saat ini)
  const all=[...Array(24).keys()];
  const closed=run(pair,src.rows,'balanced',all);
  const s=E.summarize(closed);
  const hrs=summarizeHours(closed);
  console.log('==== '+pair+'  ('+path.basename(src.file)+', '+src.rows.length+' ticks) ====');
  console.log('balanced ALL hours gate  '+f(s));
  const rated=hrs.filter(x=>x.n>=MIN_N);
  rated.sort((a,b)=>b.avgR-a.avgR);
  console.log('jam (n≥'+MIN_N+'):');
  for(const x of rated){
    const tag=x.avgR>=GOOD_AVGR?'GOOD':(x.avgR<=BAD_AVGR?'BAD ':'meh ');
    console.log('  '+tag+' h='+String(x.h).padStart(2,'0')+
      ' n='+String(x.n).padStart(3)+' wr='+(x.wr*100).toFixed(0).padStart(3)+'%'+
      ' avgR='+x.avgR.toFixed(3).padStart(7)+' PF='+(x.pf==null?'—':x.pf.toFixed(2)).padStart(5)+
      ' tot='+x.tot.toFixed(2).padStart(6));
  }
  const good=rated.filter(x=>x.avgR>=GOOD_AVGR).map(x=>x.h).sort((a,b)=>a-b);
  const bad=rated.filter(x=>x.avgR<=BAD_AVGR).map(x=>x.h).sort((a,b)=>a-b);
  const keep=good.length?good:rated.filter(x=>x.avgR>0).map(x=>x.h).sort((a,b)=>a-b);
  console.log('usulan hours=['+keep.join(',')+']  (buang bad=['+bad.join(',')+'])');
  if(keep.length){
    const filt=run(pair,src.rows,'balanced',keep);
    console.log('balanced LIVE hours    '+f(E.summarize(filt)));
  }
  console.log('');
}
