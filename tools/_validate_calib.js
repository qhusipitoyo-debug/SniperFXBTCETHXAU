#!/usr/bin/env node
/* Validasi live-gate setelah kalibrasi hours/modeFloor di engine.js (bukan post-filter). */
const E=require('../engine.js');
const fs=require('fs');
const path=require('path');

function load(f){
  const rows=[];
  for(const line of fs.readFileSync(f,'utf8').split(/\n/)){
    const c=line.split(',');if(c.length<3)continue;
    const t=Number(c[0]),b=Number(c[1]),a=Number(c[2]);
    if(t&&b>0&&a>=b)rows.push([t,b,a]);
  }
  return rows;
}
function run(pair,file,mode,evalMs){
  const ticks=load(file);
  const eng=E.create(pair,{mode,stale:60000,feed:'bt'});
  let last=0;
  for(const [t,b,a] of ticks){eng.onTick(t,b,a);if(t-last>=(evalMs||2000)){eng.evaluate(t);last=t}}
  return E.summarize(eng.closed);
}
function f(s){
  if(!s.n)return 'n=0';
  return 'n='+String(s.n).padStart(3)+' wr='+((s.winRate||0)*100).toFixed(1).padStart(5)+'% avgR='+
    (s.avgR||0).toFixed(3).padStart(7)+' PF='+(s.pf==null?'—':s.pf.toFixed(2)).padStart(5)+
    ' tot='+(s.totalR||0).toFixed(2).padStart(7)+' DD='+(s.maxDD||0).toFixed(1);
}

const jobs=[
  ['XAUUSD','PAXGUSDT','balanced'],
  ['XAUUSD','PAXGUSDT','liquidity'],
  ['XAUUSD','PAXGUSDT','auto'],
  ['BTCUSD','BTCUSDT','balanced'],
  ['BTCUSD','BTCUSDT','precision'],
  ['ETHUSD','ETHUSDT','balanced'],
  ['ETHUSD','ETHUSDT','momentum'],
  ['EURUSD','EURUSDT','balanced']
];
console.log('Live-gate validation • hours/modeFloor dari engine.js\n');
console.log('Pair     Mode        | hasil');
console.log('---------|------------|------------------------------------------');
for(const [pair,sym,mode] of jobs){
  const file=path.join(__dirname,'../data',sym+'_1m.csv');
  if(!fs.existsSync(file)){console.log(pair,mode,'MISSING',file);continue}
  const s=run(pair,file,mode);
  const P=E.PAIRS[pair];
  console.log(pair.padEnd(8),mode.padEnd(11),f(s),'  hours=['+(P.hours||[]).join(',')+']');
}
console.log('\nBaseline lama (pre-calib, sebelum hours/modeFloor):');
console.log('XAU bal n=124 wr=46.8% avgR=+0.026 PF=1.18');
console.log('BTC bal n=393 wr=41.5% avgR=-0.033 PF=0.79');
console.log('ETH bal n=39  wr=41.0% avgR=-0.011 PF=0.91');
console.log('Target live-gate (v6): XAU bal PF≥1.7 · BTC bal PF≥1.6 · ETH bal PF≥3');
