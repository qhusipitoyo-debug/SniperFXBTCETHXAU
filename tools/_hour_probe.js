#!/usr/bin/env node
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
function f(s){
  if(!s.n)return 'n=0';
  return 'n='+s.n+' wr='+((s.winRate||0)*100).toFixed(1)+'% avgR='+(s.avgR||0).toFixed(3)+
    ' PF='+(s.pf||0).toFixed(2)+' tot='+(s.totalR||0).toFixed(2)+' DD='+(s.maxDD||0).toFixed(1);
}
function runFilterHours(pair,file,mode,allow,deny,evalMs){
  const ticks=load(file);
  const eng=E.create(pair,{mode,stale:60000,feed:'bt'});
  let last=0;
  for(const [t,b,a] of ticks){eng.onTick(t,b,a);if(t-last>=(evalMs||2000)){eng.evaluate(t);last=t}}
  let list=eng.closed.slice();
  if(allow)list=list.filter(t=>allow.includes(new Date(t.t).getUTCHours()));
  if(deny)list=list.filter(t=>!deny.includes(new Date(t.t).getUTCHours()));
  return E.summarize(list);
}
function runParams(pair,file,mode,params,modeOverride,evalMs){
  const ticks=load(file);
  const eng=E.create(pair,{mode,stale:60000,feed:'bt',params:params||{},modeOverride:modeOverride||{}});
  let last=0;
  for(const [t,b,a] of ticks){eng.onTick(t,b,a);if(t-last>=(evalMs||2000)){eng.evaluate(t);last=t}}
  return E.summarize(eng.closed);
}

const xau=path.join(__dirname,'../data/PAXGUSDT_1m.csv');
const btc=path.join(__dirname,'../data/BTCUSDT_1m.csv');
const eth=path.join(__dirname,'../data/ETHUSDT_1m.csv');

console.log('=== XAUUSD hour post-filter ===');
console.log('balanced ALL     ', f(runFilterHours('XAUUSD',xau,'balanced')));
console.log('balanced good hrs', f(runFilterHours('XAUUSD',xau,'balanced',[7,8,10,11,13,15])));
console.log('balanced deny bad', f(runFilterHours('XAUUSD',xau,'balanced',null,[9,14,16,17,18,19])));
console.log('auto ALL         ', f(runFilterHours('XAUUSD',xau,'auto')));
console.log('auto good hrs    ', f(runFilterHours('XAUUSD',xau,'auto',[7,8,10,11,13,15])));
console.log('liq good         ', f(runFilterHours('XAUUSD',xau,'liquidity',[7,8,10,11,13,15])));

console.log('\n=== XAUUSD param tweaks (live gate) ===');
console.log('bal +score.52    ', f(runParams('XAUUSD',xau,'balanced',{},{minScore:.52,minER:.34,minCost:4.0})));
console.log('bal BRK.50       ', f(runParams('XAUUSD',xau,'balanced',{BRK_CEIL:.50})));
console.log('bal TP1=.8       ', f(runParams('XAUUSD',xau,'balanced',{TP1_R:.8,TP2_R:1.8})));
console.log('bal BE=.3        ', f(runParams('XAUUSD',xau,'balanced',{BE_AT_R:.3})));
console.log('bal TTL 45m      ', f(runParams('XAUUSD',xau,'balanced',{PLAN_TTL:45*60000})));

console.log('\n=== BTCUSD ===');
console.log('balanced ALL     ', f(runFilterHours('BTCUSD',btc,'balanced')));
console.log('balanced good hrs', f(runFilterHours('BTCUSD',btc,'balanced',[8,9,19,23])));
console.log('balanced deny bad', f(runFilterHours('BTCUSD',btc,'balanced',null,[0,1,3,4,5,6,10,11,13,14,20,21])));
console.log('prec good hrs    ', f(runFilterHours('BTCUSD',btc,'precision',[8,9,19,23])));
console.log('bal score.58 cost4.5', f(runParams('BTCUSD',btc,'balanced',{},{minScore:.58,minER:.38,minCost:4.5,persist:30000})));

console.log('\n=== ETHUSD ===');
console.log('balanced ALL     ', f(runFilterHours('ETHUSD',eth,'balanced')));
console.log('balanced good hrs', f(runFilterHours('ETHUSD',eth,'balanced',[0,2,4,10,11,12,17,19])));
console.log('bal score.55     ', f(runParams('ETHUSD',eth,'balanced',{},{minScore:.55,minER:.36,minCost:4.0})));
