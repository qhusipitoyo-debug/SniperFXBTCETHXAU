#!/usr/bin/env node
/* Uji latch: apakah countdown SETUP benar-benar bisa mencapai 🔒 ENTRY dan bertahan,
   bukan muncul-hilang. Metrik:
     - churn   = berapa kali stage berpindah (WATCH↔SETUP) per jam — makin kecil makin stabil
     - episode = rentang satu stage; dihitung berapa SETUP yang sempat 100% vs mati di tengah
     - pin     = selama plan aktif, apakah engine masih melaporkan qualified (kandidat) alih-alih WATCH
   Pakai: node tools/latch_test.js [EURUSDT|PAXGUSDT|BTCUSDT|ETHUSDT] [hariTerakhir] */
const fs=require('fs'),path=require('path'),E=require('../engine.js');
const SYM=process.argv[2]||'EURUSDT',DAYS=Number(process.argv[3]||7);
const PAIR=E.PAIRS[SYM]?SYM:Object.keys(E.PAIRS).find(k=>(E.PAIRS[k].binance||'')===SYM.toLowerCase());
if(!PAIR){console.error('Pair tidak dikenal: '+SYM);process.exit(1)}
const file=path.join(__dirname,'..','data',SYM+'_1m.csv');
const rows=[];
for(const l of fs.readFileSync(file,'utf8').split('\n')){const c=l.split(',');if(c.length<3)continue;const t=Number(c[0]);if(!t)continue;rows.push([t,Number(c[1]),Number(c[2])])}
const start=rows[rows.length-1][0]-DAYS*86400000,ticks=rows.filter(r=>r[0]>=start);
const eng=E.create(PAIR,{mode:'balanced',stale:60000,feed:'lt'});
const PERSIST=eng.modeCfg().persist;
let lastEval=0,prevStage='',transitions=0,episodes={},setupAbort=0,setupFull=0,progSum=0,progN=0;
let pinChecks=0,pinQualified=0,lockedSeen=0;
for(const [t,b,a] of ticks){
  eng.onTick(t,b,a);
  if(t-lastEval<500)continue;lastEval=t;
  const x=eng.evaluate(t),tr=eng.trade;
  if(tr&&!tr.done){pinChecks++;lockedSeen++;if(x.qualified||x.blocked||x.stage==='ENTRY')pinQualified++}
  if(x.stage!==prevStage){
    transitions++;
    if(prevStage==='SETUP'&&x.stage!=='ENTRY')setupAbort++;
    episodes[prevStage]=(episodes[prevStage]||0)+1;
    prevStage=x.stage;
  }
  if(x.stage==='SETUP'){progN++;progSum+=x.prog/PERSIST;if(x.prog>=PERSIST)setupFull++}
}
const hours=ticks.length?((ticks[ticks.length-1][0]-ticks[0][0])/3600000):1;
console.log(SYM+' ('+PAIR+') • '+DAYS+' hari • '+ticks.length+' tick • '+hours.toFixed(1)+' jam data • persist '+PERSIST+'ms');
console.log('  stage berubah        : '+transitions+' kali  ('+(transitions/hours).toFixed(1)+'/jam)');
console.log('  episode per stage    : '+JSON.stringify(episodes));
console.log('  SETUP penuh (≥100%)  : '+setupFull+' evaluasi');
console.log('  SETUP terputus       : '+setupAbort+' episode mati sebelum ENTRY');
console.log('  rerata progress SETUP: '+(100*progSum/Math.max(1,progN)).toFixed(1)+'%');
console.log('  selama plan aktif    : '+pinChecks+' evaluasi; kandidat/ENTRY tetap tampil: '+
  (pinChecks?((100*pinQualified/pinChecks).toFixed(0)+'%'):'n/a')+'  (kartu terpaku '+lockedSeen+'×)');
console.log('  trade selesai        : '+eng.closed.length+'  →  '+JSON.stringify(E.summarize(eng.closed)));
