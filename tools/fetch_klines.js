#!/usr/bin/env node
/* Unduh 1m klines Binance (REST publik) dan tulis sebagai CSV tick ts,bid,ask untuk backtest.js.
   Satu bar diubah jadi 4 titik: o -> (h atau l dulu, ikut arah bar) -> (sisa) -> c, tiap 15 detik.
   Spread dipasang konstan = typSpread pair (broker retail) — engine memakai floor itu juga, jadi
   ATR/biaya tidak diaudit oleh spread Binance yang jauh lebih tipis daripada akun MT5.
   Pakai: node tools/fetch_klines.js EURUSDT PAXGUSDT BTCUSDT --days 30  */
const fs=require('fs'),path=require('path');
const E=require('../engine.js');
const HOSTS=['https://data-api.binance.vision','https://api.binance.com'];
const args=process.argv.slice(2),flags=args.filter(a=>a.startsWith('--'));
const syms=args.filter(a=>!a.startsWith('--'));
const opt=(n,d)=>{const f=flags.find(x=>x.startsWith('--'+n+'='));return f?Number(f.split('=')[1]):d};
const DAYS=opt('days',30),SLEEP=opt('sleep',220);
const outDir=path.join(__dirname,'..','data');
if(!syms.length){console.log('Pakai: node tools/fetch_klines.js EURUSDT PAXGUSDT BTCUSDT --days=30');process.exit(1)}
fs.mkdirSync(outDir,{recursive:true});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function get(url){
  for(const h of HOSTS){
    try{const r=await fetch(h+url,{cache:'no-store'});if(!r.ok){continue}
      const j=await r.json();if(Array.isArray(j))return j;
    }catch{}
  }
  return null;
}

(async()=>{
  for(const sym of syms){
    const pairKey=Object.keys(E.PAIRS).find(k=>(E.PAIRS[k].binance||'').toUpperCase()===sym.toUpperCase());
    const cfg=E.PAIRS[pairKey]||{pip:.0001,typSpread:1};
    const half=(cfg.typSpread*cfg.pip)/2;
    const end=Date.now(),start=end-DAYS*86400000;
    const rows=[];let cur=start,fail=0;
    while(cur<end){
      const batch=await get('/api/v3/klines?symbol='+sym.toUpperCase()+'&interval=1m&startTime='+cur+'&limit=1000');
      if(!batch){fail++;console.warn('  gagal request mulai',new Date(cur).toISOString());cur+=1000*60000;if(fail>5)break;continue}
      if(!batch.length)break;
      for(const k of batch)rows.push(k);
      cur=Number(batch[batch.length-1][0])+60000;fail=0;
      process.stdout.write('.');
      await sleep(SLEEP);
    }
    const out=[];
    for(const k of rows){
      const t0=Number(k[0]),o=+k[1],h=+k[2],l=+k[3],c=+k[4];
      const seq=o>=c?[o,h,l,c]:[o,l,h,c];
      const pts=[[t0,seq[0]],[t0+15000,seq[1]],[t0+30000,seq[2]],[t0+45000,seq[3]]];
      for(const [t,mid] of pts)out.push([t,(mid-half).toFixed(cfg.dp||5),(mid+half).toFixed(cfg.dp||5)].join(','));
    }
    const f=path.join(outDir,sym.toUpperCase()+'_1m.csv');
    fs.writeFileSync(f,'ts,bid,ask\n'+out.join('\n')+'\n');
    const first=rows.length?new Date(Number(rows[0][0])).toISOString().slice(0,10):'-',
          last=rows.length?new Date(Number(rows[rows.length-1][0])).toISOString().slice(0,10):'-';
    console.log('\n'+sym+': '+rows.length+' bar 1m ('+first+' → '+last+') → '+f+'  spread='+cfg.typSpread+' pips');
  }
})();
