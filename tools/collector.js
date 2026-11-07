#!/usr/bin/env node
/* ============================================================
   tools/collector.js — pengumpul data 24/7 tanpa browser.

   Kenapa perlu: panel di browser hanya berhitung selagi tab terbuka, dan ledger-nya
   tersimpan di localStorage per mesin. Daemon ini menjalankan engine yang SAMA
   (engine.js, file yang sama dengan yang dipakai dashboard dan backtest.js) di Node,
   jadi sampel terus bertambah walau tidak ada siapa-siapa melihat layar.

   Pakai : node tools/collector.js [--feed=deriv|binance] [--modes=balanced,edge]
                              [--pairs=EURUSD,XAUUSD] [--evalms=1000] [--quiet]
                              [--ledger=stats/live_ledger.jsonl] [--out=stats/live_stats.json]
            (dua bentuk diterima: --pairs=XAUUSD dan --pairs XAUUSD)
            node tools/collector.js --replay=data/ETHUSDT_1m.csv --pairs=ETHUSD   -- uji jalur
                              tulis-menulis tanpa menunggu satu plan selesai di feed live
   Berhenti: Ctrl-C (SIGINT) atau kill — keduanya flush dulu, tidak ada baris yang hilang separuh.

   Dua berkas keluaran:
     ledger  = satu baris JSON per plan yang SELESAI, ditulis append. Ini sumber kebenarannya;
               kalau prosesnya mati di tengah jalan, isinya tetap terbaca dan bisa di-replay.
               Belum ada plan selesai → berkasnya memang belum dibuat.
     stats   = ringkasan yang dibaca panel, ditulis ulang utuh (tmp + rename) setiap ada
               penutupan baru dan tiap detak jantung (5 menit). Hapus → regenerasi dari ledger.

   Tidak ada dependency: Node >= 22 sudah punya WebSocket dan fetch global.

   24/7 tanpa laptop: .github/workflows/collector.yml menjalankan berkas ini di GitHub
   Actions dan mengirim hasilnya lewat tools/publish.sh. Di sana window per run harus
   panjang (PLAN_TTL 60 menit) — bukan beberapa menit tiap jam.
   ============================================================ */
const fs=require('fs');
const path=require('path');
const E=require('../engine.js');

const ROOT=path.resolve(__dirname,'..');
const args=process.argv.slice(2);
const has=n=>args.includes('--'+n)||args.some(a=>a.startsWith('--'+n+'='));
const opt=(n,d)=>{
  const eq=args.find(a=>a.startsWith('--'+n+'='));
  if(eq)return eq.slice(n.length+3);
  const i=args.indexOf('--'+n);
  return i>=0&&args[i+1]&&!args[i+1].startsWith('--')?args[i+1]:d
};
const flag=n=>args.includes('--'+n);

const FEED=opt('feed','deriv');
const MODES=opt('modes','balanced').split(',').map(s=>s.trim()).filter(m=>E.MODES[m]);
const EVALMS=Math.max(250,parseFloat(opt('evalms','1000'))||1000);
let LEDGER=path.resolve(ROOT,opt('ledger','stats/live_ledger.jsonl'));
let OUT=path.resolve(ROOT,opt('out','stats/live_stats.json'));
const QUIET=flag('quiet');
/* --replay <csv> = dorong tick historis lewat jalur ingest yang sama, tanpa WebSocket.
   Bukan fitur analisis (untuk itu ada backtest.js) — ini cara menguji bahwa ledger,
   dedup, dan stats benar-benar terisi sebelum menunggu satu jam di feed live. Nama
   berkas keluaran diberi akhiran .replay DI SINI, sebelum ledger apa pun dibaca, supaya
   hasil uji tidak pernah membaca atau mencemari ledger live. */
const REPLAY=opt('replay','');
if(REPLAY){
  if(!has('ledger'))LEDGER=LEDGER.replace(/\.jsonl$/,'')+'.replay.jsonl';
  if(!has('out'))OUT=OUT.replace(/\.json$/,'')+'.replay.json';
}
const DERIV_WS='wss://api.derivws.com/trading/v1/options/ws/public';
const BINANCE_WS=['wss://data-stream.binance.vision','wss://stream.binance.com:9443','wss://stream.binance.com']
  .map(h=>h+'/stream?streams=');
const BINANCE_REST=['https://data-api.binance.vision','https://api.binance.com'];
const STALE_RECONNECT=60000;   /* tidak ada pesan sama sekali selama ini → sambung ulang */
const STATUS_EVERY=300000;     /* baris detak jantung: 5 menit */

if(!MODES.length){console.error('mode tidak dikenal — pilihan: '+Object.keys(E.MODES).join(', '));process.exit(1)}
if(FEED!=='deriv'&&FEED!=='binance'){console.error('--feed hanya deriv|binance (oanda/capital butuh kunci API)');process.exit(1)}

const N=v=>{const x=typeof v==='number'?v:parseFloat(v);return Number.isFinite(x)?x:0};
const log=(...a)=>{if(!QUIET)console.log(new Date().toISOString().slice(11,19),...a)};

/* ---------- pasangan yang bisa dilayani feed ini ---------- */
const PAIRS=E.PAIRS;
for(const k in PAIRS)PAIRS[k].deriv=PAIRS[k].deriv||'frx'+k;
const KEYS=(opt('pairs','')?opt('pairs','').split(',').map(s=>s.trim().toUpperCase()):Object.keys(PAIRS))
  .filter(k=>PAIRS[k])
  .filter(k=>FEED==='binance'?!!PAIRS[k].binance:!!PAIRS[k].deriv);
if(!KEYS.length){console.error('tidak ada pair yang cocok untuk feed '+FEED);process.exit(1)}

/* Satu engine per (pair × mode). Engine tidak tahu-menahu soal UI: ia terima tick,
   kembalikan kejadian, dan menyimpan plan yang selesai di .closed. */
const engines=new Map();
for(const pair of KEYS)for(const mode of MODES){
  engines.set(pair+'|'+mode,E.create(pair,{mode,stale:FEED==='binance'?12000:20000,
    hasFlow:FEED==='binance',feed:FEED}));
}

const stat={startedAt:Date.now(),ticks:0,quotes:0,seeded:0,lastTickAt:0,wsMsg:0,reconnects:0,writes:0,errors:0};

/* ---------- ledger: append-only, dedup lewat id plan ----------
   id plan dari engine = pair|t|side, jadi restart di tengah hari tidak menghasilkan
   baris kembar walaupun engine melihat kembali plan yang sama. */
const seen=new Set();
function loadLedger(){
  if(!fs.existsSync(LEDGER))return 0;
  let added=0;
  for(const line of fs.readFileSync(LEDGER,'utf8').split('\n')){
    if(!line.trim())continue;
    try{const r=JSON.parse(line);if(r&&r.id&&!seen.has(r.id)){seen.add(r.id);added++}}catch{}
  }
  return added;
}
function appendLedger(rows){
  if(!rows.length)return;
  fs.mkdirSync(path.dirname(LEDGER),{recursive:true});
  fs.appendFileSync(LEDGER,rows.map(r=>JSON.stringify(r)).join('\n')+'\n');
}

/* ---------- ringkasan → stats/live_stats.json ----------
   Bentuknya disengaja sama seperti keluaran tools/pair_stats.js (termasuk hours {n,w,g,l})
   supaya panel tidak perlu dua jalur kode untuk replay dan live. */
function hoursOf(tr){
  const h={};
  for(const t of tr){
    if(!t.t||typeof t.resultR!=='number')continue;
    const k=String(new Date(t.t).getUTCHours());
    const b=h[k]||(h[k]={n:0,w:0,g:0,l:0});
    b.n++;if(t.resultR>0)b.w++;
    if(t.resultR>0)b.g+=t.resultR;else b.l-=t.resultR;
  }
  for(const k of Object.keys(h))for(const f of ['g','l'])h[k][f]=Number(h[k][f].toFixed(6));
  return h;
}
function pack(tr){
  const s=E.summarize(tr),oc={};
  for(const t of tr)oc[t.done]=(oc[t.done]||0)+1;
  return {n:s.n,wins:s.wins,winRate:s.winRate,avgR:s.avgR,totalR:s.totalR,pf:s.pf,maxDD:s.maxDD,
    winLossRatio:s.winLossRatio,mfeAvg:s.mfeAvg,maeAvg:s.maeAvg,geoMiss:s.geoMiss,dirMiss:s.dirMiss,
    holdWin:s.holdWin,holdLoss:s.holdLoss,outcome:oc,hours:hoursOf(tr)};
}
function readLedger(){
  const by={};
  if(fs.existsSync(LEDGER))for(const line of fs.readFileSync(LEDGER,'utf8').split('\n')){
    if(!line.trim())continue;
    try{const r=JSON.parse(line);(by[r.pair+'|'+r.mode]=by[r.pair+'|'+r.mode]||[]).push(r)}catch{}
  }
  return by;
}
function writeStats(){
  const by=readLedger(),pairs={},totals={};
  for(const m of MODES)totals[m]={tr:[],byPair:{}};
  for(const key of Object.keys(by)){
    const [pair,mode]=key.split('|'),rows=by[key];
    ((pairs[pair]=pairs[pair]||{name:PAIRS[pair]?PAIRS[pair].name:pair,symbol:PAIRS[pair]?(FEED==='binance'?PAIRS[pair].binance:PAIRS[pair].deriv):null,modes:{}})
      .modes[mode]=pack(rows));
    if(totals[mode])totals[mode].tr.push(...rows);
  }
  const t={};
  for(const m of Object.keys(totals)){
    const s=pack(totals[m].tr);
    t[m]=Object.assign(s,{pairsTested:Object.keys(pairs).filter(k=>pairs[k].modes[m]&&pairs[k].modes[m].n).length});
  }
  const json={kind:'live',generatedAt:Date.now(),startedAt:stat.startedAt,
    uptimeMin:Number(((Date.now()-stat.startedAt)/60000).toFixed(1)),
    feed:FEED,modes:MODES,evalMs:EVALMS,pairsTested:KEYS.length,
    counters:{ticks:stat.ticks,closed:seen.size,reconnects:stat.reconnects,errors:stat.errors,
      lastTickAgeS:stat.lastTickAt?Number(((Date.now()-stat.lastTickAt)/1000).toFixed(1)):null},
    hoursKey:'jam UTC dari waktu masuk sinyal; {n,w,g,l} — avgR=(g-l)/n, PF=g/l; jam yang tidak ada berarti nol trade',
    note:'Dikumpulkan tools/collector.js dengan engine.js yang sama dengan dashboard. Spread feed publik sudah termasuk; slippage dan komisi TIDAK.',
    pairs,total:t};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  const tmp=OUT+'.tmp';
  fs.writeFileSync(tmp,JSON.stringify(json));
  fs.renameSync(tmp,OUT);   /* rename atomik: panel tidak pernah membaca berkas separuh */
  stat.writes++;
}

/* ---------- alur satu quote ---------- */
let lastEval=0;
function ingest(pair,bid,ask,now,flow){
  if(!(bid>0&&ask>0&&ask>=bid)||!PAIRS[pair])return;
  stat.ticks++;stat.lastTickAt=now;
  for(const mode of MODES){
    const eng=engines.get(pair+'|'+mode);if(!eng)continue;
    if(flow&&eng.addFlow)eng.addFlow(now,flow);
    eng.onTick(now,bid,ask);
  }
  if(now-lastEval>=EVALMS){lastEval=now;drain(now)}
}
/* Drain = panggil evaluate pada semua engine, lalu angkat plan yang baru selesai ke ledger.
   .closed cuma bertambah, jadi cukup ingat berapa panjang yang sudah dikonsumsi. */
const consumed={};
function drain(now){
  const fresh=[];
  for(const [key,eng] of engines){
    try{eng.evaluate(now)}catch(err){stat.errors++;log('evaluate',key,err&&err.message)}
    const done=eng.closed||[],from=consumed[key]||0;
    if(done.length>from){
      for(const tr of done.slice(from)){
        if(!tr||!tr.id||seen.has(tr.id))continue;
        seen.add(tr.id);
        const [pair,mode]=key.split('|');
        fresh.push({id:tr.id,pair,mode,feed:FEED,t:tr.t,closedAt:tr.closedAt,side:tr.side,
          done:tr.done,resultR:typeof tr.resultR==='number'?Number(tr.resultR.toFixed(6)):null,
          mfe:typeof tr.mfe==='number'?Number(tr.mfe.toFixed(4)):null,
          mae:typeof tr.mae==='number'?Number(tr.mae.toFixed(4)):null,
          entry:tr.entry,sl:tr.sl,tp1:tr.tp1,tp2:tr.tp2,spread:tr.spread});
      }
      consumed[key]=done.length;
    }
  }
  if(fresh.length){
    appendLedger(fresh);writeStats();
    log('CLOSED +'+fresh.length+' (total '+seen.size+') '+
      fresh.map(r=>r.pair+'/'+r.mode+' '+r.done+' '+(r.resultR>0?'+':'')+r.resultR+'R').slice(0,4).join('  '));
  }
}

/* ---------- WebSocket dengan backoff, sama seperti openWS di app.js ---------- */
function openWS(url,onOpen,onMsg,label){
  let ws=null,delay=500,dead=false,timer=null;
  const go=()=>{
    if(dead)return;
    try{
      const me=new WebSocket(url);ws=me;
      me.onopen=()=>{if(dead||ws!==me){try{me.close()}catch{}return}
        if(stat.wsMsg)stat.reconnects++;   /* sambungan pertama bukan "reconnect" */
        delay=500;log('['+label+'] connected');
        try{onOpen&&onOpen(me)}catch(err){log('['+label+'] subscribe gagal',err&&err.message)}};
      me.onmessage=e=>{if(dead||ws!==me)return;
        stat.wsMsg++;stat.lastMsgAt=Date.now();
        try{onMsg(JSON.parse(e.data))}catch(err){stat.errors++;log('['+label+'] parse',err&&err.message)}};
      me.onerror=()=>{if(!dead&&ws===me)log('['+label+'] error')};
      me.onclose=ev=>{if(dead||ws!==me)return;
        log('['+label+'] closed code='+(ev&&ev.code)+' — retry '+delay+'ms');
        timer=setTimeout(go,delay);delay=Math.min(15000,delay*2)};
    }catch(err){stat.errors++;log('['+label+'] open fail',err&&err.message);timer=setTimeout(go,delay)}
  };
  go();
  return()=>{dead=true;clearTimeout(timer);const w=ws;ws=null;try{w&&w.close()}catch{}};
}

/* ---------- prefill bar 1 menit supaya engine tidak mulai dari nol ---------- */
const needBars=mode=>{const p=E.MODES[mode]&&E.MODES[mode].params?E.MODES[mode].params:E.PARAMS;
  return Math.min(1000,((p.MIN_BARS||60)+3)*(p.BAR_MIN||1))};
function seed(eng,bars){try{const n=eng.seedBars(bars)||0;stat.seeded+=n;return n}catch{return 0}}

async function prefillDeriv(ws){
  for(const pair of KEYS){
    const sym=PAIRS[pair].deriv;
    ws.send(JSON.stringify({ticks:sym,subscribe:1}));
    ws.send(JSON.stringify({ticks_history:sym,adjust_start_time:1,count:needBars(),end:'latest',granularity:60,style:'candles'}));
    await new Promise(r=>setTimeout(r,120));   /* satu per satu: Deriv membatasi permintaan beruntun */
  }
}
async function prefillBinance(){
  for(const pair of KEYS){
    const sym=String(PAIRS[pair].binance).toUpperCase(),limit=needBars();
    for(const h of BINANCE_REST){
      try{
        const r=await fetch(h+'/api/v3/klines?symbol='+sym+'&interval=1m&limit='+limit,{cache:'no-store'});
        if(!r.ok)continue;
        const rows=await r.json();
        let n=0;
        for(const mode of MODES){const eng=engines.get(pair+'|'+mode);if(eng)n=Math.max(n,seed(eng,
          rows.map(k=>({k:Math.floor(N(k[0])/60000),o:N(k[1]),h:N(k[2]),l:N(k[3]),c:N(k[4])}))))}
        log('prefill',pair,n,'bar');
        break;
      }catch{continue}
    }
  }
}

/* ---------- penyambungan feed ---------- */
let stop=null,hostIdx=0,dead=false;
/* Kode error yang merupakan keadaan pasar, bukan kegagalan daemon. Pasar tutup di akhir
   pekan membuat SETIAP subscribe gagal, dan watchdog bertanya lagi tiap menit — kalau
   dihitung sebagai error, panel akan membaca "error 480" padahal daemon-nya sehat. */
const MARKET_STATE={MarketIsClosed:1,MarketNotOpen:1};
const errSeen={};
function derivError(msg){
  const code=String((msg.error&&msg.error.code)||'?');
  errSeen[code]=(errSeen[code]||0)+1;
  if(!MARKET_STATE[code])stat.errors++;
  if(errSeen[code]===1||errSeen[code]%20===0)
    log('deriv',code+(errSeen[code]>1?' ×'+errSeen[code]:''),
      MARKET_STATE[code]?'— pasar tutup, daemon standby (tidak ada tick, tidak ada plan)':(msg.error&&msg.error.message)||'');
}

function startDeriv(){
  const symToPair={};for(const k of KEYS)symToPair[PAIRS[k].deriv]=k;
  const pending=new Set(Object.values(symToPair));
  log('feed deriv •',KEYS.length,'pair ×',MODES.length,'mode =',KEYS.length*MODES.length,'engine');
  stop=openWS(DERIV_WS,ws=>{prefillDeriv(ws)},msg=>{
    if(msg.candles&&msg.echo_req){
      const sym=msg.echo_req.ticks_history||msg.echo_req.ticks,pair=symToPair[sym];
      if(pair){pending.delete(sym);
        const bars=(msg.candles||[]).map(c=>({k:Math.floor(N(c.epoch)/60),o:N(c.open),h:N(c.high),l:N(c.low),c:N(c.close)}));
        for(const mode of MODES){const eng=engines.get(pair+'|'+mode);if(eng)seed(eng,bars)}
        writeStats();
      }
      return;
    }
    if(msg.error){derivError(msg);return}
    const t=msg.tick;if(!t)return;
    const pair=symToPair[t.symbol||''];if(!pair)return;
    let bid=N(t.bid),ask=N(t.ask);const q=N(t.quote),now=t.epoch?N(t.epoch)*1000:Date.now();
    if(!(bid>0&&ask>0)){if(!(q>0))return;const half=(PAIRS[pair].pip||.0001)*.4;bid=q-half;ask=q+half}
    ingest(pair,bid,ask,now);
  },'deriv');
}
function startBinance(){
  const syms=KEYS.map(k=>PAIRS[k].binance);
  const symToPair={};for(const k of KEYS)symToPair[String(PAIRS[k].binance).toLowerCase()]=k;
  const streams=syms.map(s=>s+'@bookTicker/'+s+'@trade').join('/');
  const url=BINANCE_WS[hostIdx%BINANCE_WS.length]+streams;
  log('feed binance •',KEYS.length,'pair ×',MODES.length,'mode =',KEYS.length*MODES.length,'engine');
  stop=openWS(url,null,msg=>{
    const stream=String(msg.stream||''),d=msg.data||msg,now=Date.now();
    const m=stream.match(/^([a-z0-9]+)@/),sym=m?m[1]:String(d.s||'').toLowerCase(),pair=symToPair[sym];
    if(!pair)return;
    if(stream.endsWith('@bookTicker')||(d.b&&d.a)){ingest(pair,N(d.b),N(d.a),now);return}
    if(stream.endsWith('@trade')||d.e==='trade'){
      const q=N(d.q);if(q>0)ingest(pair,q,q,now,(d.m?-1:1)*q);   /* quote sebagai harga tunggal: spread sudah ada di bookTicker */
    }
  },'binance');
  prefillBinance();
  /* REST fallback — sama seperti panel: hanya dipakai kalau WS sedang diam */
  setInterval(async()=>{
    if(dead)return;
    if(stat.lastMsgAt&&Date.now()-stat.lastMsgAt<3000)return;
    for(const k of KEYS){
      try{
        const h=BINANCE_REST[hostIdx%BINANCE_REST.length];
        const r=await fetch(h+'/api/v3/ticker/bookTicker?symbol='+String(PAIRS[k].binance).toUpperCase(),{cache:'no-store'});
        if(!r.ok)continue;
        const d=await r.json();ingest(k,N(d.bidPrice),N(d.askPrice),Date.now());
      }catch{hostIdx++}
    }
  },1500);
}

/* ---------- penjaga & detak jantung ---------- */
setInterval(()=>{
  if(dead)return;
  const idle=stat.lastMsgAt?Date.now()-stat.lastMsgAt:Date.now()-stat.startedAt;
  if(idle>STALE_RECONNECT){
    log('tidak ada pesan '+Math.round(idle/1000)+'s → sambung ulang'+(E.closedFX(Date.now())?' (FX tutup, wajar untuk pair FX)':''));
    try{stop&&stop()}catch{}
    hostIdx++;
    FEED==='deriv'?startDeriv():startBinance();
  }
},15000);
setInterval(()=>{
  const age=stat.lastTickAt?Math.round((Date.now()-stat.lastTickAt)/1000)+'s':'-';
  log('detak: tick '+stat.ticks+' • pesan ws '+stat.wsMsg+' • plan selesai '+seen.size+
    ' • umur '+((Date.now()-stat.startedAt)/60000).toFixed(0)+' mnt • tick terakhir '+age+
    (E.closedFX(Date.now())?' • FX TUTUP (hanya pair 24/7 yang bergerak)':''));
  writeStats();
},STATUS_EVERY);

/* ---------- penutup yang rapi ---------- */
function shutdown(sig){
  if(dead)return;dead=true;
  log(sig+' → flush…');
  try{stop&&stop()}catch{}
  try{drain(Date.now())}catch{}
  try{writeStats()}catch(err){log('flush gagal',err&&err.message)}
  /* Ledger append-only tidak pernah dibuat selama belum ada satu plan pun yang selesai —
     bilang "tertulis di ledger" padahal tidak ada berkasnya akan menyesatkan. */
  log('tertulis di '+path.relative(ROOT,OUT)+(fs.existsSync(LEDGER)?' dan '+path.relative(ROOT,LEDGER):' (belum ada plan selesai — ledger tidak dibuat)'));
  process.exit(0);
}
process.on('SIGINT',()=>shutdown('SIGINT'));
process.on('SIGTERM',()=>shutdown('SIGTERM'));
/* Daemon yang mati karena satu exception tak terduga lebih berbahaya daripada yang
   melanjutkan; tapi kalau meledak >30x/menit itu hot loop — keluar saja biar kelihatan. */
let errBurst=0;
process.on('uncaughtException',err=>{
  stat.errors++;errBurst++;log('uncaught',err&&err.stack?err.stack.split('\n')[1]:err);
  if(errBurst>30){log('terlalu banyak exception dalam satu menit — berhenti');process.exit(1)}
  setTimeout(()=>errBurst=Math.max(0,errBurst-1),2000);
});
process.on('unhandledRejection',err=>{stat.errors++;log('unhandledRejection',err&&err.message)});

/* --replay <csv> = dorong tick historis lewat jalur ingest yang sama, tanpa WebSocket.
   Bukan fitur analisis (untuk itu ada backtest.js) — ini cara menguji bahwa ledger,
   dedup, dan stats benar-benar terisi sebelum menunggu satu jam di feed live. */
const known=loadLedger();
log('collector • '+(REPLAY?'replay '+path.basename(REPLAY):'feed '+FEED)+' • mode '+MODES.join(',')+
  ' • '+KEYS.length+' pair × '+MODES.length+' mode • '+path.relative(ROOT,LEDGER));
if(known)log(known,'baris plan sudah ada di ledger — tidak akan dicatat dua kali');
writeStats();

if(REPLAY){
  const file=path.resolve(ROOT,REPLAY);
  if(!fs.existsSync(file)){console.error('berkas replay tidak ada: '+file);process.exit(1)}
  const rows=[];
  for(const line of fs.readFileSync(file,'utf8').split(/\r?\n/)){
    if(!line.trim())continue;
    const c=line.split(',');if(c.length<3)continue;
    let t=Number(c[0]);if(isNaN(t))t=Date.parse(c[0]);else if(t<1e11)t*=1000;
    const b=parseFloat(c[1]),a=parseFloat(c[2]);
    if(t>0&&b>0&&a>0&&a>=b)rows.push([t,b,a]);
  }
  rows.sort((x,y)=>x[0]-y[0]);
  const pair=KEYS[0];
  log('replay '+path.basename(file)+' • '+rows.length+' baris • pair '+pair+' • '+MODES.join(','));
  for(const [t,b,a] of rows)ingest(pair,b,a,t);
  drain(rows.length?rows[rows.length-1][0]:Date.now());
  /* writeStats() di jalur live hanya dipanggil saat ada plan baru; run kedua replay tidak
     menutup satu pun plan (semuanya sudah ada di ledger) sehingga ringkasannya tetap
     punya counter dari sebelum tick mana pun diproses. Tulis sekali di sini. */
  writeStats();
  log('selesai — '+seen.size+' plan, '+stat.ticks+' tick, tertulis di '+path.relative(ROOT,OUT));
  process.exit(0);
}

FEED==='deriv'?startDeriv():startBinance();
