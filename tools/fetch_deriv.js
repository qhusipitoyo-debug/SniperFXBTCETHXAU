#!/usr/bin/env node
/* Unduh candle 1m Deriv (symbol frx… / cry…) → data/<PAIR>_1m.csv (format ts,bid,ask).
   Binance hanya punya EURUSDT untuk FX; major lain diambil dari sini supaya pair_stats
   bisa kalibrasi jam. Spread = typSpread pair (broker retail), sama seperti fetch_klines.js.

   Pakai: node tools/fetch_deriv.js GBPUSD AUDUSD USDJPY --days=45
          node tools/fetch_deriv.js --all --days=45
*/
const fs=require('fs'),path=require('path');
const E=require('../engine.js');

const WS_URL='wss://api.derivws.com/trading/v1/options/ws/public';
const args=process.argv.slice(2);
const flags=args.filter(a=>a.startsWith('--'));
const want=args.filter(a=>!a.startsWith('--')).map(s=>s.toUpperCase());
const opt=(n,d)=>{const f=flags.find(x=>x.startsWith('--'+n+'='));return f?Number(f.split('=')[1]):d};
const DAYS=opt('days',45);
const COUNT=Math.min(5000,opt('count',4500)); // Deriv max ~5000/request
const ALL=flags.includes('--all');
const outDir=path.join(__dirname,'..','data');
fs.mkdirSync(outDir,{recursive:true});

for(const k of Object.keys(E.PAIRS))E.PAIRS[k].deriv=E.PAIRS[k].deriv||('frx'+k);
const FX_DEFAULT=['EURUSD','GBPUSD','USDJPY','USDCHF','AUDUSD','USDCAD','NZDUSD'];
const keys=ALL?FX_DEFAULT:(want.length?want:FX_DEFAULT.filter(k=>k!=='EURUSD'));
const pairs=keys.filter(k=>E.PAIRS[k]);
if(!pairs.length){console.error('Pair tidak dikenal. Contoh: GBPUSD AUDUSD USDJPY');process.exit(1)}

function open(){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket(WS_URL);
    const t=setTimeout(()=>{try{ws.close()}catch{};reject(new Error('WS open timeout'))},20000);
    ws.addEventListener('open',()=>{clearTimeout(t);resolve(ws)});
    ws.addEventListener('error',()=>{clearTimeout(t);reject(new Error('WS error'))});
  });
}

function req(ws,payload,timeoutMs){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error('req timeout '+JSON.stringify(payload).slice(0,80))),timeoutMs||45000);
    const onMsg=ev=>{
      let m;try{m=JSON.parse(ev.data)}catch{return}
      if(m.error){
        // abaikan error yang bukan untuk request ini
        if(m.echo_req&&payload.ticks_history&&m.echo_req.ticks_history!==payload.ticks_history)return;
        ws.removeEventListener('message',onMsg);clearTimeout(t);
        reject(Object.assign(new Error(m.error.message||m.error.code),{code:m.error.code}));
        return;
      }
      if(payload.ticks_history&&m.candles&&m.echo_req&&m.echo_req.ticks_history===payload.ticks_history){
        ws.removeEventListener('message',onMsg);clearTimeout(t);resolve(m.candles||[]);
      }
    };
    ws.addEventListener('message',onMsg);
    ws.send(JSON.stringify(payload));
  });
}

async function fetchPair(ws,pair){
  const P=E.PAIRS[pair];
  const sym=P.deriv;
  const half=(P.typSpread*P.pip)/2;
  const endMs=Date.now();
  const startMs=endMs-DAYS*86400000;
  const byEpoch=new Map();
  let end=Math.floor(endMs/1000);
  let guard=0;
  process.stdout.write(pair+'/'+sym+' ');
  while(guard++<40){
    let candles;
    try{
      candles=await req(ws,{ticks_history:sym,adjust_start_time:1,count:COUNT,end,style:'candles',granularity:60});
    }catch(e){
      if(e.code==='MarketIsClosed'||e.code==='MarketNotOpen'){
        // mundur ke Jumat sebelumnya saat pasar masih buka
        end-=3*86400;process.stdout.write('closed↻');continue;
      }
      throw e;
    }
    if(!candles.length)break;
    for(const c of candles){
      const ep=Number(c.epoch);
      if(ep*1000<startMs)continue;
      byEpoch.set(ep,c);
    }
    const oldest=Math.min(...candles.map(c=>Number(c.epoch)));
    process.stdout.write('.');
    if(oldest*1000<=startMs)break;
    if(candles.length<10)break;
    end=oldest-60;
    await new Promise(r=>setTimeout(r,350));
  }
  const rows=[...byEpoch.keys()].sort((a,b)=>a-b).map(ep=>byEpoch.get(ep));
  const out=[];
  for(const c of rows){
    const t0=Number(c.epoch)*1000;
    const o=+c.open,h=+c.high,l=+c.low,cl=+c.close;
    const seq=o>=cl?[o,h,l,cl]:[o,l,h,cl];
    const pts=[[t0,seq[0]],[t0+15000,seq[1]],[t0+30000,seq[2]],[t0+45000,seq[3]]];
    for(const [t,mid] of pts){
      out.push([t,(mid-half).toFixed(P.dp),(mid+half).toFixed(P.dp)].join(','));
    }
  }
  const f=path.join(outDir,pair+'_1m.csv');
  fs.writeFileSync(f,'ts,bid,ask\n'+out.join('\n')+'\n');
  const first=rows.length?new Date(Number(rows[0].epoch)*1000).toISOString().slice(0,10):'-';
  const last=rows.length?new Date(Number(rows[rows.length-1].epoch)*1000).toISOString().slice(0,10):'-';
  console.log(' '+rows.length+' bar ('+first+'→'+last+') → '+path.basename(f)+' spread='+P.typSpread);
  return rows.length;
}

(async()=>{
  console.log('Deriv fetch • days='+DAYS+' • '+pairs.join(', '));
  const ws=await open();
  try{
    for(const pair of pairs){
      try{await fetchPair(ws,pair)}
      catch(e){console.error('\n  GAGAL '+pair+':',e.code||'',e.message)}
      await new Promise(r=>setTimeout(r,500));
    }
  }finally{try{ws.close()}catch{}}
})().catch(e=>{console.error(e);process.exit(1)});
