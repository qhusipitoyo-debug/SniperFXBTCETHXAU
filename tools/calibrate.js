#!/usr/bin/env node
/* Kalibrasi walk-forward multi-aset memakai engine.js yang sama dengan live.
   Data   : CSV ts,bid,ask hasil tools/fetch_klines.js (1m klines → 4 tick/menit, spread dipatok typSpread pair).
   Metode : greedy coordinate search di TRAIN (60% awal) saja; TEST (40% akhir) cuma dibaca SEKALI di akhir.
            Angka TEST tidak pernah ikut memilih, jadi angka TEST tidak bocor ke parameter.
   Pakai  : node tools/calibrate.js            → pencarian + validasi
            node tools/calibrate.js --report   → validasi config yang sekarang ada di engine.js
   Catatan: 1 task = (config, aset, segmen). Tugas dibagi rata ke NWORK worker. */
const fs=require('fs'),path=require('path'),os=require('os');
const {Worker,isMainThread}=require('worker_threads');
const E=require('../engine.js');
const NWORK=Math.max(2,Math.min(4,(os.cpus().length||4)-1));
const ASSETS=[['EURUSD','EURUSDT'],['XAUUSD','PAXGUSDT'],['BTCUSD','BTCUSDT'],['ETHUSD','ETHUSDT']];
const SPLIT=.6,EVALMS=2000,MIN_POOL=40,MIN_EACH=3;
const DATA=s=>path.join(__dirname,'..','data',s+'_1m.csv');
const flag=n=>process.argv.includes('--'+n);
const f2=v=>v==null||Number.isNaN(v)?'—':(v===Infinity?'∞':Number(v).toFixed(3));

const DIMS=[
  {k:'BAR_MIN',    t:'params', v:[1,3,5,15]},
  {k:'minScore',   t:'mode',   v:[.30,.36,.42,.48]},
  {k:'minER',      t:'mode',   v:[.16,.22,.28,.34]},
  {k:'minCost',    t:'mode',   v:[1.6,2.2,2.8,3.4]},
  {k:'persist',    t:'mode',   v:[4000,10000,20000,30000]},
  {k:'cooldown',   t:'mode',   v:[5*60000,15*60000,30*60000]},
  {k:'SL_ATR_MULT',t:'params', v:[2.0,2.6,3.2]},
  {k:'TP1_R',      t:'params', v:[.8,1.0,1.4],link:{.8:{TP2_R:1.8},1:{TP2_R:2.2},1.4:{TP2_R:2.8}}},
  {k:'MIN_MOM',    t:'params', v:[.06,.12,.20],link:{.06:{MIN_TREND:.06},.12:{MIN_TREND:.12},.2:{MIN_TREND:.20}}},
  {k:'HTF_SOFT',   t:'params', v:[-.20,-.08,.05]},
  {k:'BRK_CEIL',   t:'params', v:[.75,.88,1.01]}
];
const BASE={mode:{minScore:.48,minER:.32,minCost:2.4,persist:20000,cooldown:15*60000},
            params:{BAR_MIN:5,SL_ATR_MULT:3.2,TP1_R:1.0,TP2_R:2.2,MIN_MOM:.12,MIN_TREND:.12,HTF_SOFT:-.08,BRK_CEIL:.88}};
const key=c=>JSON.stringify(c);
const label=c=>`TF=${c.params.BAR_MIN}m score≥${c.mode.minScore} ER≥${c.mode.minER} ATR/bia≥${c.mode.minCost} persist=${c.mode.persist/1000}s cd=${c.mode.cooldown/60000}m `+
  `SL=${c.params.SL_ATR_MULT}× TP=${c.params.TP1_R}/${c.params.TP2_R} mom/trend≥${c.params.MIN_MOM} htf≥${c.params.HTF_SOFT} ceil=${c.params.BRK_CEIL}`;

/* =================== WORKER =================== */
if(!isMainThread){
  const {parentPort}=require('worker_threads'),cache={};
  function load(sym){
    if(cache[sym])return cache[sym];
    const f=DATA(sym),rows=[],txt=fs.readFileSync(f,'utf8').split('\n');
    for(const l of txt){const c=l.split(',');if(c.length<3)continue;const t=Number(c[0]);if(!t)continue;rows.push([t,Number(c[1]),Number(c[2])])}
    const cut=rows[Math.floor(rows.length*SPLIT)][0];
    return(cache[sym]={rows,cut});
  }
  parentPort.on('message',m=>{
    const out=[];
    for(const tk of m){
      const {rows,cut}=load(tk.sym),from=tk.which==='train'?0:cut,to=tk.which==='train'?cut:Infinity;
      const eng=E.create(tk.pair,{mode:'balanced',modeOverride:tk.cfg.mode,params:tk.cfg.params,stale:60000,feed:'bt'});
      let last=0;
      for(const [t,b,a] of rows){if(t<from||t>to)continue;eng.onTick(t,b,a);if(t-last>=EVALMS){eng.evaluate(t);last=t}}
      const list=eng.closed.slice(),h={};let pos=0,neg=0;
      for(const x of list){const k=new Date(x.t).getUTCHours();(h[k]=h[k]||[]).push(x);if(x.resultR>0)pos+=x.resultR;else neg-=x.resultR}
      out.push({id:tk.id,sym:tk.sym,which:tk.which,pos,neg,sum:E.summarize(list),
        hours:Object.keys(h).map(Number).sort((a,b)=>a-b).map(k=>[k,E.summarize(h[k])])});
    }
    parentPort.postMessage(out);
  });
}

/* =================== MAIN =================== */
else{
  const workers=[];
  for(let i=0;i<NWORK;i++)workers.push(new Worker(__filename));
  // satu aset = satu lane worker: setiap worker hanya memuat 1 CSV (hemat RAM, tetap seimbang karena jumlah tugas per aset sama)
  const LANE={};ASSETS.forEach(([p,s],i)=>LANE[s]=i%NWORK);
  function ask(worker,tasks){return new Promise((res,rej)=>{worker.once('message',res);worker.once('error',rej);worker.postMessage(tasks)})}
  async function dispatch(tasks){
    if(!tasks.length)return[];
    const groups=Array.from({length:NWORK},()=>[]);
    tasks.forEach(t=>groups[LANE[t.sym]].push(t));
    return(await Promise.all(groups.map((g,i)=>g.length?ask(workers[i],g):Promise.resolve([])))).flat();
  }
  function tasksFor(cfgs,which){
    const out=[];
    cfgs.forEach((cfg,ci)=>ASSETS.forEach(([pair,sym])=>out.push({id:ci,pair,sym,which,cfg})));
    return out;
  }
  function rollup(rows,cfgs){
    const byId={};
    rows.forEach(r=>(byId[r.id]=byId[r.id]||[]).push(r));
    return cfgs.map((cfg,i)=>{
      const rs=byId[i]||[],per={};let n=0,total=0,gp=0,gl=0;
      rs.forEach(r=>{const s=r.sum;per[r.sym]=s;n+=s.n;total+=s.totalR;gp+=r.pos||0;gl+=r.neg||0});
      const minEach=Math.min(...ASSETS.map(([p,s])=>per[s]?per[s].n:0));
      const avgR=n?total/n:null;
      const okSample=n>=MIN_POOL&&minEach>=MIN_EACH;
      return{cfg,n,avgR,pf:gl>0?gp/gl:(gp>0?Infinity:null),maxDD:Math.max(0,...rs.map(r=>r.sum.maxDD)),minEach,per,
        ok:okSample&&avgR>0,okSample,wins:rs.reduce((a,r)=>a+(r.sum.wins||0),0),
        // peringkat TIDAK disaring oleh profit: kalau memang rugi, pencarian tetap mencari yang paling sedikit rugi
        rank:okSample?(avgR==null?-9:avgR*Math.min(1,n/120)):-9};
    });
  }
  const evalCfg=(cfg,which)=>dispatch(tasksFor([cfg],which)).then(r=>rollup(r,[cfg])[0]);
  const evalMany=(cfgs,which)=>dispatch(tasksFor(cfgs,which)).then(r=>rollup(r,cfgs));

  async function report(cfg,title){
    const tr=await evalCfg(cfg,'train'),te=await evalCfg(cfg,'test');
    console.log('\n=== '+title+' ===\n  '+label(cfg));
    [['TRAIN',tr],['TEST',te]].forEach(([w,r])=>{
      console.log('  '+w+'  n='+String(r.n).padStart(4)+'  avgR='+f2(r.avgR)+'  PF='+f2(r.pf)+'  maxDD='+f2(r.maxDD)+'R  terkecil/aset='+r.minEach);
      ASSETS.forEach(([p,s])=>{const q=r.per[s];if(q)console.log('        '+s.padEnd(9)+' n='+String(q.n).padStart(3)+
        '  win='+((q.winRate||0)*100).toFixed(0).padStart(3)+'%  avgR='+f2(q.avgR)+'  totalR='+f2(q.totalR)+'  PF='+f2(q.pf))});
    });
    return{tr,te};
  }

  (async()=>{
    for(const [p,s] of ASSETS)if(!fs.existsSync(DATA(s))){console.log('Data belum ada:',DATA(s),'— jalankan tools/fetch_klines.js');workers.forEach(w=>w.terminate());process.exit(1)}
    console.log('Greedy coordinate search • '+NWORK+' worker • train 60% / test 40% • aset '+ASSETS.map(a=>a[1]).join(', ')+' • eval '+EVALMS+'ms');
    if(flag('report')){const r=await report(BASE,'CONFIG SEKARANG (default engine.js)');workers.forEach(w=>w.terminate());
      console.log('\n'+(r.te.ok?'✔ bertahan di TEST':'✘ TIDAK bertahan di TEST'));process.exit(0)}

    let best=JSON.parse(JSON.stringify(BASE)),bestR=await evalCfg(best,'train');
    console.log('  awal: '+label(best)+'\n        n='+bestR.n+' avgR='+f2(bestR.avgR)+(bestR.okSample?(bestR.avgR>0?'':'  [rugi — pencarian mencari yang paling sedikit rugi]'):'  [sampel di bawah minimal]'));
    for(let pass=1;pass<=4;pass++){
      const cand=[];
      DIMS.forEach(d=>d.v.forEach(val=>{
        const c=JSON.parse(JSON.stringify(best)),box=c[d.t];
        box[d.k]=val;if(d.link&&d.link[val])Object.assign(box,d.link[val]);
        if(key(c)!==key(best))cand.push(c);
      }));
      const uniq=[...new Map(cand.map(c=>[key(c),c])).values()];
      const sc=await evalMany(uniq,'train');
      sc.sort((a,b)=>b.rank-a.rank);
      console.log('\npass '+pass+' — '+uniq.length+' kandidat di TRAIN:');
      sc.slice(0,6).forEach(r=>console.log('   n='+String(r.n).padStart(4)+' avgR='+f2(r.avgR)+' PF='+f2(r.pf)+' minE='+String(r.minEach).padStart(2)+
        '  ['+(r.n<MIN_POOL||r.minEach<MIN_EACH?'sampel kurang':(r.avgR<=0?'avgR ≤ 0 (rugi)':'ok'))+']  '+label(r.cfg)));
      const top=sc[0];
      if(!top.okSample){console.log('   ✘ berhenti: tidak ada kandidat dengan sampel memadai (pooled ≥ '+MIN_POOL+', tiap aset ≥ '+MIN_EACH+')');break}
      if(top.rank<=-9){console.log('   ✘ berhenti: seluruh kandidat rugi sampelnya kecil');break}
      if(top.rank>bestR.rank+1e-9){best=top.cfg;bestR=top;console.log('   → terima: '+label(best))}
      else{console.log('   → tidak ada perbaikan, berhenti');break}
    }
    const r=await report(best,'HASIL PENCARIAN');
    console.log('\nPutusan: '+(r.te.ok&&r.te.pf>1.05
      ?'✔ bertahan di TEST (avgR '+f2(r.te.avgR)+', PF '+f2(r.te.pf)+') — layak ditulis ke engine.js'
      :'✘ TIDAK bertahan di TEST (n='+r.te.n+', avgR '+f2(r.te.avgR)+', PF '+f2(r.te.pf)+') — ini bukti tidak ada edge pada data ini, bukan bahan optimasi'));
    console.log('\nCONFIG='+JSON.stringify(best));
    workers.forEach(w=>w.terminate());
    process.exit(0);
  })().catch(e=>{console.error(e&&e.stack||e);process.exit(1)});
}
