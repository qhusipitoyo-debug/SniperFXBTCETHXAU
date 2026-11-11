/* ============================================================
   FX MAJORS SNIPER — BUILD v6 MULTI-SCANNER
   Semua pair di-scan paralel; yang lolos threshold + plan tampil di dashboard.
   Informational only. Analisis lokal — tidak terhubung ke broker/terminal apa pun.
   ============================================================ */
console.log('[app] FX Sniper v6 multi-scanner loaded');

const $=id=>document.getElementById(id);
const N=x=>Number(x)||0;
const E=window.FXEngine;
if(!E)console.error('engine.js belum termuat');

const STORE='fxSniper2';
const PAIRS=E.PAIRS;
const ALL_KEYS=Object.keys(PAIRS);

const FEEDS={
  hybrid:{label:'Binance + Deriv (Hybrid)',short:'HYBRID',stale:15000,flow:true},
  deriv: {label:'Deriv (14 Pair)',        short:'DERIV', stale:20000,flow:false},
  binance:{label:'Binance (BTC/ETH USDT)', short:'BINANCE',stale:12000,flow:true}
};
const DERIV_WS='wss://api.derivws.com/trading/v1/options/ws/public';
const BINANCE_WS_HOSTS=['wss://data-stream.binance.vision','wss://stream.binance.com:9443','wss://stream.binance.com'];
const BINANCE_REST_HOSTS=['https://data-api.binance.vision','https://api.binance.com'];
const _qs=new URLSearchParams(location.search);
const lsGet=k=>{try{return localStorage.getItem(k)}catch{return null}};
const lsSet=(k,v)=>{try{localStorage.setItem(k,v)}catch{}};
const normPair=q=>String(q||'').toUpperCase().replace(/[^A-Z]/g,'');

let selectedFeed=(()=>{const q=_qs.get('feed')||lsGet('fxSniperFeed');return FEEDS[q]?q:'hybrid'})();
let selectedPair=(()=>{const q=normPair(_qs.get('pair')||lsGet('fxSniperPair'));return PAIRS[q]?q:'EURUSD'})();
let selectedMode=(()=>{const q=_qs.get('mode')||lsGet('fxSniperMode');return (E.MODES&&E.MODES[q])?q:'agresif'})();
let scanFilter=(()=>{const q=_qs.get('filter')||lsGet('fxSniperFilter');return ['action','threshold','all'].includes(q)?q:'action'})();

const engines={};          // pair -> engine
const quotes={};           // pair -> {bid,ask,last,ts}
const signalStates={};     // pair -> UI signal state
const plans={};            // pair -> locked plan (or null)
const chartPtsBy={};       // pair -> chart points
const chartSeedBy={};      // pair -> markets.json generatedAt used to seed the chart
function seedChartPair(pair,bars,generatedAt){
  if(!QbarsArray(bars))return;
  if(chartSeedBy[pair]===generatedAt)return;
  const pts=bars
    .filter(b=>Number.isFinite(Number(b.c))&&Number(b.c)>0&&Number.isFinite(Number(b.k)))
    .map(b=>({ts:Number(b.k)*60000,p:Number(b.c)}));
  if(!pts.length)return;
  chartPtsBy[pair]=pts;
  chartSeedBy[pair]=generatedAt;
}
function QbarsArray(v){return Array.isArray(v);}
const rec=[];              // export ticks: [ts,pair,bid,ask]
let lastRec=0,feedNote='',stopFeed=null;
let restPollTimer=null,feedWatchTimer=null,lastWsMsg=0;
let storedEntries=[],historyEntries=[];
let settings={balance:1000,riskPct:1};
let planText='';

const BASE_TITLE='FX Multi Scanner';
const CONTRACT_UNITS=100000;
const EP=E.PARAMS, TP1_R=EP.TP1_R, TP2_R=EP.TP2_R, PLAN_TTL=EP.PLAN_TTL, MAX_DRIFT=.25, FRESH_SEC=120;
const LATCH_MS=30000;      // berapa lama kandidat/ENTRY tetap tampil saat skor kedip sesaat
const boardSig={};         // id -> signature HTML terakhir, supaya board tidak dibangun ulang tiap 500ms

const caps=()=>FEEDS[selectedFeed]||FEEDS.hybrid;
const pairCfg=k=>PAIRS[k||selectedPair]||PAIRS.EURUSD;
const fxClosed=()=>E.closedFX(Date.now());
const scanKeys=()=>{
  const base=selectedFeed==='binance'?ALL_KEYS.filter(k=>PAIRS[k].binance):ALL_KEYS;
  if(!fxClosed())return base;
  const only=base.filter(k=>PAIRS[k].h24);
  return only.length?only:base;
};
const fmtPct=v=>`${N(v)>=0?'+':''}${(N(v)*100).toFixed(3)}%`;
const sgn=(v,d=2)=>`${N(v)>=0?'+':''}${N(v).toFixed(d)}`;
const fmtR=v=>v==null?'—':sgn(v,2)+'R';
const pipUsdPerLot=(c,price)=>c.quoteUSD?(c.units||CONTRACT_UNITS)*c.pip:(c.units||CONTRACT_UNITS)*c.pip/price;

function safeText(id,txt){try{const el=$(id);if(el)el.textContent=txt}catch{}}
function safeSetClass(id,str){try{const el=$(id);if(el)el.className=str}catch{}}
function safeHTML(id,html){try{const el=$(id);if(el)el.innerHTML=html}catch{}}
function safeStyle(id,prop,val){try{const el=$(id);if(el&&el.style)el.style[prop]=val}catch{}}
/* Board dibangun ulang hanya bila isinya benar-benar berubah. innerHTML buta tiap 500ms = kartu berkedip
   dan hover/klik hilang, yang terasa seperti "sinyalnya muncul sebentar lalu hilang". */
function setBoard(id,html){if(boardSig[id]===html)return;boardSig[id]=html;safeHTML(id,html)}
function fmtTime(ms){return ms?new Date(ms).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}):'—'}

function openWS(url,onOpen,onMsg,label='ws'){
  let ws=null,delay=500,dead=false,timer=null;
  const retry=()=>{if(dead)return;timer=setTimeout(go,delay);delay=Math.min(15000,delay*2)};
  const go=()=>{
    if(dead)return;
    try{
      const me=new WebSocket(url);ws=me;
      me.onopen=()=>{if(dead||ws!==me){try{me.close()}catch{}return}console.log(`[${label}] connected`);try{onOpen&&onOpen(me)}catch{}};
      me.onmessage=e=>{if(dead||ws!==me)return;delay=500;try{onMsg(JSON.parse(e.data))}catch(err){console.warn(`[${label}] parse`,err)}};
      me.onerror=()=>{if(!dead&&ws===me)console.info(`[${label}] network error — reconnect otomatis`)};
      me.onclose=ev=>{if(dead||ws!==me)return;
        /* 1006 = koneksi putus tanpa close frame (Wi-Fi/proxy/server). Itu keadaan jaringan
           normal dan sudah ditangani retry, jadi jangan dicetak sebagai error merah. */
        const net=[1000,1001,1005,1006].includes(ev.code),log=net?console.info:console.warn;
        log(`[${label}] ${net?'reconnect':'closed'} code=${ev.code} — retry ${delay}ms`);retry()};
    }catch(err){console.error(`[${label}] open fail`,err);retry()}
  };
  go();
  return()=>{dead=true;clearTimeout(timer);const w=ws;ws=null;try{w&&w.close()}catch{}};
}

function clearFeedHelpers(){
  if(restPollTimer){clearInterval(restPollTimer);restPollTimer=null}
  if(feedWatchTimer){clearInterval(feedWatchTimer);feedWatchTimer=null}
}

/* ---------- quote + engine ingest per pair ---------- */
function ingestPair(pair,bid,ask,now){
  if(!(bid>0&&ask>0&&ask>=bid)||!PAIRS[pair])return;
  const mid=(bid+ask)/2;
  quotes[pair]={bid,ask,last:mid,ts:now};
  const pts=chartPtsBy[pair]||(chartPtsBy[pair]=[]);
  const L=pts[pts.length-1];
  if(!L||now-L.ts>=1000){pts.push({ts:now,p:mid});while(pts.length&&now-pts[0].ts>3600000)pts.shift()}
  if(now-lastRec>=400){rec.push([now,pair,bid,ask]);lastRec=now;if(rec.length>400000)rec.splice(0,50000)}
  const eng=engines[pair];
  if(eng)handleEvents(pair,eng.onTick(now,bid,ask));
}

function handleEvents(pair,evs){
  let closed=false;
  for(const ev of evs){
    if(ev.type==='CLOSE'){closeRow(ev.trade);closed=true}
    if(ev.type==='CLOSE'||ev.type==='TP1'||ev.type==='BE')saveAll();
  }
  if(closed)renderPairStats();
}

/* ---------- market data prefill & feeds (Binance + Deriv) ---------- */
function seedEng(eng,bars){
  try{const n=eng?eng.seedBars(bars):0;if(n)console.log('[prefill]',eng.pair&&eng.pair().name,n,'bar')}catch(e){console.warn('seed',e)}
}

function needBars(pair){
  const p=engines[pair]?engines[pair].params():E.PARAMS;
  return Math.min(1000,Math.max(320,(Math.max(p.MIN_BARS||12,62))*(p.BAR_MIN||1)));
}

async function prefillBinancePair(pair,sym){
  if(!sym)return;
  const limit=needBars(pair);
  for(const h of BINANCE_REST_HOSTS){
    try{
      const r=await fetch(h+'/api/v3/klines?symbol='+sym.toUpperCase()+'&interval=1m&limit='+limit,{cache:'no-store'});
      if(!r.ok)continue;
      const rows=await r.json();
      const bars=rows.map(k=>({k:Math.floor(k[0]/60000),o:N(k[1]),h:N(k[2]),l:N(k[3]),c:N(k[4])}));
      seedEng(engines[pair],bars);
      seedChartPair(pair,bars,'binance-prefill');
      return;
    }catch{}
  }
}

let binanceHostIdx=0;

function startBinanceMulti(keys){
  clearFeedHelpers();
  binanceHostIdx=0;lastWsMsg=Date.now();
  const syms=keys.map(k=>PAIRS[k].binance).filter(Boolean);
  if(!syms.length)return()=>{};
  let stopWs=null,dead=false;
  const streams=syms.map(s=>s+'@bookTicker/'+s+'@trade').join('/');
  const symToPair={};keys.forEach(k=>{if(PAIRS[k].binance)symToPair[PAIRS[k].binance]=k});

  const connect=()=>{
    if(dead)return;
    if(stopWs){try{stopWs()}catch{}stopWs=null}
    const host=BINANCE_WS_HOSTS[binanceHostIdx%BINANCE_WS_HOSTS.length];
    const url=host+'/stream?streams='+streams;
    console.log('[binance-multi] try',url);
    stopWs=openWS(url,null,msg=>{
      lastWsMsg=Date.now();
      const stream=String(msg.stream||''),d=msg.data||msg,now=Date.now();
      const m=stream.match(/^([a-z0-9]+)@/);
      const sym=m?m[1]:String(d.s||'').toLowerCase();
      const pair=symToPair[sym];if(!pair)return;
      if(stream.endsWith('@bookTicker')||(d.b&&d.a&&d.e===undefined)){
        feedNote='';ingestPair(pair,N(d.b),N(d.a),now);return;
      }
      if(stream.endsWith('@trade')||d.e==='trade'){
        const q=N(d.q);if(engines[pair]&&q>0)engines[pair].addFlow(now,(d.m?-1:1)*q);
      }
    },'binance-multi');
  };
  connect();

  let host=0,inflight=false;
  const poll=async()=>{
    if(inflight||dead)return;inflight=true;
    try{
      const h=BINANCE_REST_HOSTS[host%BINANCE_REST_HOSTS.length];
      await Promise.all(syms.map(async sym=>{
        try{
          const r=await fetch(h+'/api/v3/ticker/bookTicker?symbol='+sym.toUpperCase(),{cache:'no-store'});
          if(!r.ok)return;
          const d=await r.json(),pair=symToPair[sym],q=quotes[pair];
          if(!pair)return;
          if(!q||Date.now()-q.ts>2000){
            ingestPair(pair,N(d.bidPrice),N(d.askPrice),Date.now());
          }
        }catch{}
      }));
    }catch{host++}finally{inflight=false}
  };
  restPollTimer=setInterval(poll,1500);poll();
  syms.forEach(sym=>prefillBinancePair(symToPair[sym],sym));

  feedWatchTimer=setInterval(()=>{
    if(dead)return;
    const gap=Date.now()-lastWsMsg;
    if(lastWsMsg&&gap<8000)return;
    const anyFresh=keys.some(k=>quotes[k]&&Date.now()-quotes[k].ts<8000);
    if(!lastWsMsg&&anyFresh)return;
    binanceHostIdx=(binanceHostIdx+1)%BINANCE_WS_HOSTS.length;
    feedNote='Binance failover #'+(binanceHostIdx+1);
    connect();
  },6000);

  return()=>{dead=true;clearFeedHelpers();if(stopWs)try{stopWs()}catch{}};
}

function startDerivMulti(keys){
  clearFeedHelpers();lastWsMsg=Date.now();
  const pendingHist=new Set();
  let pingTimer=null,dead=false;
  const stopWs=openWS(DERIV_WS,ws=>{
    if(pingTimer)clearInterval(pingTimer);
    pingTimer=setInterval(()=>{try{ws.send(JSON.stringify({ping:1}))}catch{}},15000);
    keys.forEach(k=>{
      const sym=PAIRS[k].deriv;if(!sym)return;
      ws.send(JSON.stringify({ticks:sym,subscribe:1}));
      pendingHist.add(sym);
      ws.send(JSON.stringify({ticks_history:sym,adjust_start_time:1,count:needBars(k),end:'latest',granularity:60,style:'candles'}));
    });
  },msg=>{
    lastWsMsg=Date.now();
    if(msg.candles&&msg.echo_req){
      const sym=msg.echo_req.ticks_history||msg.echo_req.ticks;
      const pair=keys.find(k=>PAIRS[k].deriv===sym);
      if(pair){
        pendingHist.delete(sym);
        const bars=(msg.candles||[]).map(c=>({k:Math.floor(N(c.epoch)/60),o:N(c.open),h:N(c.high),l:N(c.low),c:N(c.close)}));
        seedEng(engines[pair],bars);
        seedChartPair(pair,bars,'deriv-candles');
      }
      return;
    }
    if(msg.error){
      const errSym=msg.echo_req?(msg.echo_req.ticks_history||msg.echo_req.ticks):'';
      if(msg.error.code==='MarketIsClosed'||msg.error.code==='MarketNotOpen'){
        if(errSym&&msg.echo_req&&msg.echo_req.ticks_history&&msg.echo_req.end==='latest'){
          const fri=Math.floor((Date.now()-(Date.now()%86400000+86400000*2))/1000);
          try{ws.send(JSON.stringify({ticks_history:errSym,adjust_start_time:1,count:needBars(keys.find(k=>PAIRS[k].deriv===errSym)),end:fri,granularity:60,style:'candles'}))}catch{}
        }
        return;
      }
      feedNote='Deriv: '+String(msg.error.message||msg.error.code||'error');return;
    }
    const t=msg.tick;if(!t)return;
    const pair=keys.find(k=>PAIRS[k].deriv===(t.symbol||''));if(!pair)return;
    let bid=N(t.bid),ask=N(t.ask),q=N(t.quote);
    const now=t.epoch?N(t.epoch)*1000:Date.now();
    if(!(bid>0&&ask>0)){
      if(!(q>0))return;
      const half=PAIRS[pair].pip*.4;bid=q-half;ask=q+half;
    }
    feedNote='';ingestPair(pair,bid,ask,now);
  },'deriv-multi');

  feedWatchTimer=setInterval(()=>{
    if(dead||fxClosed())return;
    if(Date.now()-lastWsMsg>Math.max(caps().stale*2,30000)){
      feedNote='Deriv stale — reconnect…';
      startFeed();
    }
  },10000);

  return()=>{dead=true;clearFeedHelpers();if(pingTimer)clearInterval(pingTimer);try{stopWs()}catch{}};
}

function startHybridMulti(keys){
  clearFeedHelpers();feedNote='';lastWsMsg=Date.now();
  const binKeys=keys.filter(k=>!!PAIRS[k].binance);
  const derivKeys=keys.filter(k=>!PAIRS[k].binance);
  const stopBin=startBinanceMulti(binKeys);
  const stopDer=startDerivMulti(derivKeys);
  return()=>{try{stopBin()}catch{};try{stopDer()}catch{}};
}

function buildEngines(keys){
  Object.keys(engines).forEach(k=>delete engines[k]);
  const now=Date.now(),today=Math.floor(now/86400000);
  keys.forEach(pair=>{
    const hasFlow=(selectedFeed==='binance'||selectedFeed==='hybrid')&&!!PAIRS[pair].binance;
    const eng=E.create(pair,{mode:selectedMode,stale:caps().stale,hasFlow,feed:selectedFeed});
    const mine=storedEntries.filter(e=>e.pair===pair);
    eng.seed({now,lastEntry:mine.reduce((a,e)=>Math.max(a,e.generatedAt||0),0),
      dayR:mine.filter(e=>typeof e.resultR==='number'&&Math.floor((e.closedAt||0)/86400000)===today).reduce((a,e)=>a+e.resultR,0)});
    if(plans[pair]&&!plans[pair].done&&now<plans[pair].expires)eng.restoreTrade(plans[pair]);
    engines[pair]=eng;
    if(!signalStates[pair])signalStates[pair]={stage:'WAIT',side:'WAIT',confidence:0,generatedAt:0,validUntil:0,potential:0,reason:'Warming',confirming:false};
  });
}

let feedClosedAt=null;   // status bursa saat feed terakhir dilanggan — kalau berbalik (Jumat 22:00 / Minggu 22:00 / libur) feed disusun ulang
/* ---------- berita kalender + sentimen pasar (stats/calendar.json + stats/sentiment.json + CORS live) ---------- */
const NEWS_CAL_URL='stats/calendar.json';
const SENTIMENT_URL='stats/sentiment.json';
const FNG_LIVE_URL='https://api.alternative.me/fng/?limit=2';
const BINANCE_24H_URL='https://data-api.binance.vision/api/v3/ticker/24hr?symbols='+encodeURIComponent(JSON.stringify(['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT','PAXGUSDT','EURUSDT']));
const C=window.FXContext||{};
let NEWS_EVENTS=[];
let MARKET_SENTIMENT=null;
let NEWS_LAST_FETCH=0;
const NEWS_REFRESH_MS=15*60*1000;
const SENT_BASE={}; // {pair:{t,mid}} anchor untuk menghitung USD/Risk breadth intraday

function pairMid(pair){
  const q=quotes[pair]; if(!q)return null;
  const m=q.last||((q.bid&&q.ask)?(q.bid+q.ask)/2:0);
  return m>0?m:null;
}
function newsSnapKey(e){ return 'fxSniperNewsSnap:'+String(e.Date)+'|'+String(e.Event); }
function captureNewsSnapshot(e){
  try{
    if(localStorage.getItem(newsSnapKey(e))) return;
    const t=e.ts||new Date(e.Date).getTime(); if(!Number.isFinite(t))return;
    const now=Date.now(); if(now>=t||t-now>3600000)return;
    const prices={}; ALL_KEYS.forEach(k=>{const m=pairMid(k); if(m)prices[k]=m;});
    if(!Object.keys(prices).length)return;
    localStorage.setItem(newsSnapKey(e),JSON.stringify({prices,capturedAt:new Date(now).toISOString()}));
  }catch(err){}
}
function newsPrePrice(e,pair){
  try{
    const raw=localStorage.getItem(newsSnapKey(e));
    if(raw){const snap=JSON.parse(raw);if(snap&&snap.prices&&snap.prices[pair])return snap.prices[pair];}
  }catch{}
  return null;
}
function newsBias(pair,now){
  if(!NEWS_EVENTS.length||!C.newsBias)return null;
  return C.newsBias(NEWS_EVENTS,pair,now,newsPrePrice,pairMid(pair));
}
function updateSentAnchors(now){
  ALL_KEYS.forEach(k=>{
    const m=pairMid(k); if(!(m>0))return;
    const a=SENT_BASE[k];
    if(!a||(now-a.t)>3600000)SENT_BASE[k]={t:now,mid:m};
  });
}
function computeLiveMacro(){
  const usdVotes=[],riskVotes=[];
  for(const k of ['USDJPY','USDCHF','USDCAD']){
    const m=pairMid(k),b=SENT_BASE[k]&&SENT_BASE[k].mid;
    if(m>0&&b>0)usdVotes.push(((m-b)/b)*100);
  }
  for(const k of ['EURUSD','GBPUSD','AUDUSD','NZDUSD']){
    const m=pairMid(k),b=SENT_BASE[k]&&SENT_BASE[k].mid;
    if(m>0&&b>0)usdVotes.push(-((m-b)/b)*100);
  }
  for(const k of ['NAS100','US500','BTCUSD','ETHUSD']){
    const m=pairMid(k),b=SENT_BASE[k]&&SENT_BASE[k].mid;
    if(m>0&&b>0)riskVotes.push(((m-b)/b)*100);
  }
  const usdScore=usdVotes.length>=4?Math.max(-1,Math.min(1,(usdVotes.reduce((a,b)=>a+b,0)/usdVotes.length)/0.35)):null;
  const riskScore=riskVotes.length>=2?Math.max(-1,Math.min(1,(riskVotes.reduce((a,b)=>a+b,0)/riskVotes.length)/0.6)):null;
  return {usdScore,riskScore};
}
function sentimentBias(pair){
  if(!C.pairSentimentBias)return null;
  return C.pairSentimentBias(pair,MARKET_SENTIMENT,computeLiveMacro());
}
async function refreshNews(){
  NEWS_LAST_FETCH=Date.now();
  let raw=[];
  try{
    const r=await fetch(NEWS_CAL_URL+'?v='+Date.now(),{cache:'no-store'});
    if(r.ok){const j=await r.json(); raw=Array.isArray(j)?j:(j.events||[]);}
  }catch(e){console.warn('[news] kalender gagal',e);}
  NEWS_EVENTS=(C.newsNormalize?raw.map(C.newsNormalize):raw).filter(Boolean);
  try{
    const sr=await fetch(SENTIMENT_URL+'?v='+Date.now(),{cache:'no-store'});
    if(sr.ok)MARKET_SENTIMENT=await sr.json();
  }catch{}
  // Live CORS enrichment: Fear & Greed + Binance 24h
  try{
    const [fr,br]=await Promise.allSettled([fetch(FNG_LIVE_URL,{cache:'no-store'}),fetch(BINANCE_24H_URL,{cache:'no-store'})]);
    const next=Object.assign({},MARKET_SENTIMENT||{});
    if(fr.status==='fulfilled'&&fr.value.ok){
      const fj=await fr.value.json();
      if(fj&&Array.isArray(fj.data)&&fj.data.length){
        const val=Number(fj.data[0].value),prev=fj.data[1]?Number(fj.data[1].value):val;
        next.fng={value:val,classification:fj.data[0].value_classification||'Neutral',delta1d:val-prev,score:Number(((val-50)/50).toFixed(3))};
      }
    }
    if(br.status==='fulfilled'&&br.value.ok){
      const bj=await br.value.json();
      if(Array.isArray(bj)&&bj.length){
        const mp={};bj.forEach(x=>{mp[x.symbol]={pct24h:Number(x.priceChangePercent),last:Number(x.lastPrice)};});
        const cl=['BTCUSDT','ETHUSDT','SOLUSDT','BNBUSDT'].filter(s=>mp[s]);
        const cAvg=cl.length?cl.reduce((a,s)=>a+mp[s].pct24h,0)/cl.length:0;
        const eurP=mp.EURUSDT?mp.EURUSDT.pct24h:0;
        next.market24h=Object.assign({},next.market24h||{},{cryptoAvgPct:cAvg,eurPct:eurP,riskBias:Math.max(-1,Math.min(1,cAvg/4)),usdProxyBias:Math.max(-1,Math.min(1,-eurP))});
      }
    }
    MARKET_SENTIMENT=next;
  }catch{}
  try{ E.setNewsProvider((pair,now)=>newsBias(pair,now)); }catch(e){}
  try{ if(E.setSentimentProvider) E.setSentimentProvider((pair,now)=>sentimentBias(pair,now)); }catch(e){}
  NEWS_EVENTS.forEach(captureNewsSnapshot);
  console.log('[context] calendar=',NEWS_EVENTS.length,'fng=',MARKET_SENTIMENT&&MARKET_SENTIMENT.fng?MARKET_SENTIMENT.fng.value:'n/a');
}
function newsTick(){
  updateSentAnchors(Date.now());
  NEWS_EVENTS.forEach(captureNewsSnapshot);
}
if(typeof setInterval!=='undefined'){ setInterval(newsTick,30000); setInterval(()=>{ if(Date.now()-NEWS_LAST_FETCH>NEWS_REFRESH_MS) refreshNews(); },60000); }

function startFeed(){
  if(stopFeed){try{stopFeed()}catch{}stopFeed=null}
  clearFeedHelpers();
  feedNote='';lastWsMsg=Date.now();rec.length=0;lastRec=0;
  ALL_KEYS.forEach(k=>{quotes[k]=quotes[k]||{bid:0,ask:0,last:0,ts:0};quotes[k].ts=0});
  const keys=scanKeys();
  feedClosedAt=fxClosed();
  buildEngines(keys);
  if(selectedFeed==='binance'){
    if(!keys.length){feedNote='Binance tidak punya pair majors penuh — pilih HYBRID atau DERIV';return}
    stopFeed=startBinanceMulti(keys);
  }else if(selectedFeed==='deriv'){
    stopFeed=startDerivMulti(keys);
  }else{
    stopFeed=startHybridMulti(keys);
  }
  if(!keys.includes(selectedPair))selectedPair=keys[0]||'EURUSD';
  const ps=$('pairSelect');if(ps)ps.value=selectedPair;
}

/* ---------- signal lock per pair ----------
   Prioritas state (jangan sampai ada yang "hilang" gara-gara satu evaluate nakal):
     1. x.fired                 → ENTRY baru saja terkunci
     2. engine punya trade aktif→ ENTRY TERPAKU selama plan hidup (dulu cuma 45 dtk, lalu kartu lenyap
        padahal plan masih jalan — inilah "lolos threshold sebentar lalu hilang")
     3. plan baru selesai       → DONE 60 dtk (jembatan ke panel riwayat)
     4. x.qualified             → SETUP + perpanjang latch
     5. latch masih hidup       → tahan stage sebelumnya, tandai "(latch)"
     6. selain itu              → ikuti engine (WATCH/WAIT)                                */
function stableSignal(pair,x){
  const now=Date.now();
  const prev=signalStates[pair]||{stage:'WAIT',side:'WAIT',confidence:0,generatedAt:0,validUntil:0,potential:0,reason:'',confirming:false,holdUntil:0,locked:false,near:false};
  const eng=engines[pair],tr=eng?eng.trade:null,pl=plans[pair];
  const order=x.trade?x.trade.order:(x.side==='UP'?'BUY':(x.side==='DOWN'?'SELL':'—'));
  const base={stage:x.stage,side:x.side,order,confidence:x.confidence,generatedAt:prev.generatedAt,validUntil:0,
    potential:x.potential,reason:x.reason,confirming:!!x.confirming,locked:!!x.locked,holdUntil:0,
    prog:x.prog||0,persistMs:x.persistMs||10000,busy:''};
  let s;
  if(x.fired&&x.trade){
    plans[pair]=x.trade;
    persistEntry({stage:'ENTRY',side:x.side,order:x.trade.order,confidence:x.confidence,upProb:x.upProbability,downProb:x.downProbability,
      generatedAt:now,pair,id:x.trade.id,plan:{entry:x.trade.entry,sl:x.trade.sl,tp1:x.trade.tp1,tp2:x.trade.tp2,slPips:x.trade.slPips}});
    saveAll();
    s=Object.assign(base,{stage:'ENTRY',generatedAt:now,validUntil:now+(EP.PLAN_TTL||45*60000),locked:true,confirming:false,prog:x.persistMs});
  }else if(tr&&!tr.done){
    plans[pair]=tr;
    const lbl=tr.order||(tr.side==='UP'?'BUY':'SELL');
    s=Object.assign(base,{stage:'ENTRY',side:tr.side,order:lbl,generatedAt:tr.t,validUntil:tr.expires,locked:true,confirming:false,
      prog:base.persistMs,
      reason:tr.tp1hit?'✅ TP1 tercapai — 50% ditutup, SL di entry, sisanya tahan ke TP2'
        :(tr.beArmed?'🟡 BE — SL sudah digeser ke entry, tahan TP2'
        :'🔒 ORDER VALID TERKUNCI · '+lbl+' @ '+tr.entry+' · aktif sejak '+fmtTime(tr.t))});
  }else if(pl&&pl.done&&pl.closedAt&&now-pl.closedAt<60000){
    s=Object.assign(base,{stage:'DONE',side:pl.side,order:pl.order||(pl.side==='UP'?'BUY':'SELL'),generatedAt:pl.t,locked:false,confirming:false,
      reason:({SL:'🔴 SL',TP2:'🏆 TP2',BE:'⚪ BE',TIME:'⏱ TIME OUT'}[pl.done]||'Selesai')+' • '+fmtR(pl.resultR)+' • pindah ke riwayat segera'});
  }else if(x.qualified){
    s=Object.assign(base,{holdUntil:now+LATCH_MS});
  }else if(now<(prev.holdUntil||0)&&(prev.stage==='SETUP'||prev.stage==='ENTRY')&&!x.hard){
    s=Object.assign(base,{stage:prev.stage,side:prev.side,order:prev.order,generatedAt:prev.generatedAt,holdUntil:prev.holdUntil,
      locked:prev.locked,confirming:prev.stage==='SETUP',prog:prev.prog,persistMs:prev.persistMs,
      reason:(prev.reason||'')+' · ditahan (latch) '+Math.ceil(((prev.holdUntil||0)-now)/1000)+'s'});
  }else{
    s=base;
  }
  // hysteresis "nyaris lolos": masuk di minScore×NEAR_ENTER, keluar di minScore×NEAR_EXIT
  const mode=eng?eng.modeCfg():E.MODES.balanced,a=x.status==='ok'?Math.abs(x.score):0;
  const enter=mode.minScore*(EP.NEAR_ENTER||.85),exit=mode.minScore*(EP.NEAR_EXIT||.65);
  s.near=x.hard?false:(prev.near?a>=exit:a>=enter);
  s.busy=(!x.fired&&tr&&!tr.done)?'':(x.blocked||'');
  signalStates[pair]=s;
  return s;
}

function passesThreshold(pair,x,s){
  if(s.locked||s.stage==='ENTRY')return true;
  if(s.stage==='SETUP'&&s.confirming)return true;
  if(scanFilter==='action')return false;
  if(scanFilter==='all')return true;
  return !!s.near;
}

function lotFor(plan){
  const c=PAIRS[plan.pair]||pairCfg(),bal=N(settings.balance),riskUsd=bal*N(settings.riskPct)/100;
  const pipv=pipUsdPerLot(c,plan.entry),slPips=plan.slDist/c.pip;
  let lot=Math.floor(riskUsd/(slPips*pipv)*100)/100;if(!(lot>=.01))lot=.01;
  return{lot,riskUsd:lot*slPips*pipv,slPips,c};
}

function planCardHtml(pair,x,s,now){
  const q=quotes[pair]||{},c=PAIRS[pair],dp=c.dp;
  const stored=plans[pair]&&plans[pair].pair===pair?plans[pair]:null;
  const locked=!!(stored&&!stored.done),fin=!!(stored&&stored.done);
  /* Blok angka muncul di TIGA keadaan kartu: plan terkunci, plan selesai, dan countdown / threshold (preview). */
  const preview=(!locked&&!fin&&engines[pair]&&s.side&&s.side!=='WAIT')?engines[pair].preview(s.side):null;
  const p=locked||fin?stored:preview;
  const buy=s.side==='UP',lbl=buy?'BUY':'SELL';
  const stageCls=s.stage==='ENTRY'?'entry':(s.stage==='DONE'?'done':(s.confirming?'setup':'watch'));
  const pct=Math.max(0,Math.min(100,Math.round((s.prog/Math.max(1,s.persistMs))*100)));
  let levels='';
  if(p){
    const f=v=>Number(v).toFixed(dp);
    const L=lotFor(p);
    const doneLbl=fin?({SL:'🔴 SL',TP2:'🏆 TP2',BE:'⚪ BE',TIME:'⏱ TIME'})[p.done]||p.done:'';
    levels=`
      <div class="alertLevels">
        <div><span>ORDER</span><b class="${buy?'upText':'downText'}">${locked?'🔒 ':''}${lbl}</b></div>
        <div><span>ENTRY</span><b>${locked||fin?'':'≈ '}${f(p.entry)}</b></div>
        <div><span>SL</span><b style="color:#ff5967">${f(p.sl)} · ${L.slPips.toFixed(1)}p</b></div>
        <div><span>TP1</span><b style="color:#35e58a">${f(p.tp1)}</b></div>
        <div><span>TP2</span><b style="color:#35e58a">${f(p.tp2)}</b></div>
        <div><span>LOT</span><b>${L.lot.toFixed(2)}</b></div>
        <div><span>RISK</span><b>$${L.riskUsd.toFixed(2)}</b></div>
        ${fin?`<div><span>HASIL</span><b>${doneLbl} ${fmtR(p.resultR)}</b></div>`:''}
      </div>
      <div class="alertPlanNote">${
        locked?`🔒 ORDER VALID TERKUNCI — <b>${lbl} ${f(p.entry)}</b>, SL ${f(p.sl)}, TP1 ${f(p.tp1)}, TP2 ${f(p.tp2)} (${L.lot.toFixed(2)} lot ≈ $${L.riskUsd.toFixed(2)} risiko). 50% TP1 lalu BE; sisa ke TP2.`
        :fin?`${lbl} ${f(p.entry)} → ${doneLbl} ${fmtR(p.resultR)} (risiko $${L.riskUsd.toFixed(2)} / ${L.lot.toFixed(2)} lot, SL ${f(p.sl)}).`
        :`≈ PREVIEW ORDER — dihitung live dari bar berjalan, belum terkunci. ${s.busy?'Konfirmasi ditahan: '+s.busy:'Konfirmasi '+pct+'%'}. Siap ${lbl} saat mencapai 100%.`}</div>
      <button class="copyOne" data-pair="${pair}">COPY ORDER PLAN</button>`;
  }
  const bar=s.stage==='ENTRY'?'<div class="cdBar ok"><i style="width:100%"></i></div>'
    :`<div class="cdBar${s.busy?' hold':''}"><i style="width:${pct}%"></i><em>konfirmasi ${pct}%${s.busy?' · ditahan':''}</em></div>`;
  const mid=q.last?q.last.toFixed(dp):'—';
  const age=q.ts?Math.round(Math.max(0,now-q.ts)/1000)+'s':'—';
  return `<article class="alertCard ${stageCls}${s.locked?' pinned':''}" data-pair="${pair}">
    <header>
      <div><strong>${c.name}</strong> <em>${c.nick}</em></div>
      <div class="alertSide ${buy?'upText':'downText'}">${s.stage==='ENTRY'?'🔒 ':(s.busy?'⏳ ':'')}${lbl}</div>
    </header>
    <div class="alertMeta">
      <span class="pill ${stageCls}">${s.stage}${s.confirming&&s.stage==='SETUP'?' · COUNTDOWN':''}</span>
      <span>skor ${sgn(x.score)}</span>
      <span>mid ${mid}</span>
      <span>${age}</span>
    </div>
    <div class="alertStat">${pairStatChip(pair)}</div>
    ${bar}
    <p class="alertReason">${s.reason||x.reason||''}</p>
    ${levels}
  </article>`;
}

function scanRowHtml(pair,x,s,now){
  const q=quotes[pair]||{},c=PAIRS[pair],dp=c.dp;
  const buy=s.side==='UP',lbl=buy?'BUY':'SELL';
  const active=pair===selectedPair?'active':'';
  const st=s.stage==='ENTRY'?'entry':(s.confirming?'setup':'');
  const secs=q.ts?Math.round(Math.max(0,now-q.ts)/1000):'—';
  const hb=x.hard?(x.hard.indexOf('Di luar sesi')===0?' ⏰':x.hard.indexOf('Jendela berita')===0?' 📰':' 🚫'):'';
  return `<button type="button" class="scanRow ${active} ${st}" data-pair="${pair}">
    <span class="scanPair">${c.name}</span>
    <span class="scanStage">${s.stage}${s.busy&&!s.locked?'⏳':''}${hb}</span>
    <span class="scanSide ${s.side==='UP'||s.side==='DOWN'?(buy?'upText':'downText'):''}">${s.side==='WAIT'?'—':(s.locked?'🔒 '+lbl:lbl)}</span>
    <span class="scanScore">${x.status==='ok'?sgn(x.score):'—'}</span>
    <span class="scanMid">${q.last?q.last.toFixed(dp):'—'}</span>
    <span class="scanAge">${secs==='—'?'—':secs+'s'}</span>
  </button>`;
}

function buildCopyText(pair,p){
  if(!p)return'';
  const c=PAIRS[pair],f=v=>Number(v).toFixed(c.dp);
  const buy=p.side==='UP',lbl=buy?'BUY':'SELL',L=lotFor(p);
  return `=== SNIPER ORDER PLAN ===\nAction: ${lbl} ${pair}\nType: Market Execution\nEntry: ~${f(p.entry)}\nStop Loss: ${f(p.sl)} (${L.slPips.toFixed(1)} pips)\nTake Profit 1: ${f(p.tp1)}\nTake Profit 2: ${f(p.tp2)}\nVolume: ${L.lot.toFixed(2)} Lot\nRisk: $${L.riskUsd.toFixed(2)} (${settings.riskPct}%)\nRule: 50% TP1 lalu BE (geser SL ke entry); sisa target TP2.`;
}

/* ---------- focus plan panel ---------- */
function renderFocusPlan(s,x,now){
  const pair=selectedPair,c=pairCfg(pair),q=quotes[pair]||{};
  let p=plans[pair],mode=p?(p.done?'DONE':'ACTIVE'):'NONE';
  if((!p||p.done)&&s.confirming&&s.stage==='SETUP'&&(s.side==='UP'||s.side==='DOWN')&&engines[pair]){
    const b=engines[pair].preview(s.side);if(b){p=b;mode='PREVIEW'}
  }
  safeText('focusPairName',c.name);
  if(!p){
    safeText('planAction','WAIT');safeSetClass('planAction','');
    safeText('planStatus','Belum ada plan fokus. Tunggu alert ENTRY/SETUP di board atas, atau klik pair di scanner.');
    ['planEntry','planSL','planTP1','planTP2','planLot','planRiskUsd','planRR','planAtr'].forEach(id=>safeText(id,'—'));
    safeText('planSteps','Kuning = countdown. Hijau/🔒 ENTRY = terkunci — itu satu-satunya yang layak dipakai.');
    planText='';document.title=BASE_TITLE;return;
  }
  const f=v=>v.toFixed(c.dp);
  const buy=p.side==='UP',lbl=buy?'BUY':'SELL',L=lotFor(p);
  const overRisk=N(settings.balance)*N(settings.riskPct)/100>0&&L.riskUsd>N(settings.balance)*N(settings.riskPct)/100*1.25;
  safeText('planEntry',(mode==='ACTIVE'||mode==='DONE'?'':'≈ ')+f(p.entry));
  safeText('planSL',f(p.sl)+((p.tp1hit||p.beArmed)?' (BE)':''));
  safeText('planTP1',f(p.tp1));safeText('planTP2',f(p.tp2));
  safeText('planLot',L.lot.toFixed(2));
  safeText('planRiskUsd',(overRisk?'⚠ ':'')+'$'+L.riskUsd.toFixed(2)+(overRisk?' > target':''));
  safeText('planRR','TP1 1:'+TP1_R+' • TP2 1:'+TP2_R+' • 50% @ TP1');
  safeText('planAtr',(p.atr/c.pip).toFixed(1)+' pips • SL '+L.slPips.toFixed(1)+' • spr '+(p.spread/c.pip).toFixed(1));
  let action=lbl+' '+pair,status='',cls=buy?'upText':'downText',title=BASE_TITLE;
  const cdPct=Math.max(0,Math.min(100,Math.round((s.prog/Math.max(1,s.persistMs))*100)));
  if(mode==='PREVIEW'){
    action='SIAP '+lbl;
    status='🟡 PREVIEW — belum terkunci ('+cdPct+'% '+(s.busy?'ditahan: '+s.busy:'menuju 🔒')+')';
    cls='';
  }
  else if(mode==='DONE'){action='SELESAI';cls='';status={SL:'🔴 SL',TP2:'🏆 TP2',BE:'⚪ BE',TIME:'⏱ TIME'}[p.done]||'Selesai';}
  else if(p.tp1hit){status='✅ TP1 — geser SL ke BE, tahan TP2';title='✅ '+lbl+' '+pair;}
  else if(p.beArmed){status='🟡 Profit ≥ '+EP.BE_AT_R+'R — GESER SL KE ENTRY (BE) sekarang';title='🟡 BE '+pair;}
  else{
    const age=Math.round((now-p.t)/1000);
    const px=buy?q.ask:q.bid,exit=buy?q.bid:q.ask;
    const drift=px?((buy?px-p.entry:p.entry-px)/c.pip):0;
    const rNow=exit&&p.slDist?((buy?exit-p.entry:p.entry-exit)/p.slDist):0;
    if(age<=FRESH_SEC&&drift<=MAX_DRIFT*L.slPips){status='🟢 ENTRY SEKARANG • umur '+age+'s';title='⚡ '+lbl+' '+pair;}
    else if(now<=p.expires){status='🔒 TERKUNCI · AKTIF '+(age>=60?Math.round(age/60)+' mnt':age+'s')+' • floating '+fmtR(rNow)+' • '+drift.toFixed(1)+' pips dari entry';title='🔒 '+lbl+' '+pair;}
    else status='🟡 UMUR PLAN HABIS ('+Math.round(age/60)+' mnt) • jangan kejar, tunggu kandidat baru';
  }
  safeText('planAction',action);safeSetClass('planAction',cls);safeText('planStatus',status);
  safeText('planSteps',pair+' → '+(buy?'BUY':'SELL')+' market → Lot '+L.lot.toFixed(2)+' → SL '+f(p.sl)+' → TP '+f(p.tp1)+'. 50% @ TP1 lalu BE; sisa ke TP2 '+f(p.tp2)+'. Profit ≥ '+EP.BE_AT_R+'R sebelum TP1 → geser SL ke entry.');
  planText=buildCopyText(pair,p);
  document.title=title;
}

function drawChart(pair){
  try{
    const canvas=$('btcChart');if(!canvas)return;
    const dpr=window.devicePixelRatio||1,rect=canvas.getBoundingClientRect();
    const w=Math.max(300,rect.width),h=150;
    if(canvas.width!==Math.round(w*dpr)||canvas.height!==Math.round(h*dpr)){canvas.width=Math.round(w*dpr);canvas.height=Math.round(h*dpr)}
    const ctx=canvas.getContext('2d');if(!ctx)return;
    ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,w,h);
    const raw=chartPtsBy[pair]||[];
    const step=Math.max(1,Math.floor(raw.length/500));
    const pts=raw.filter((_,i)=>i%step===0).map(z=>z.p).filter(Number.isFinite);
    if(pts.length<2)return;
    const lo=Math.min.apply(null,pts),hi=Math.max.apply(null,pts);
    const pad=Math.max((hi-lo)*.15,hi*.00001),min=lo-pad,max=hi+pad;
    ctx.strokeStyle='#172231';ctx.lineWidth=1;
    for(let i=1;i<4;i++){const y=i*h/4;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke()}
    const grad=ctx.createLinearGradient(0,0,0,h);
    grad.addColorStop(0,'rgba(53,229,138,.28)');grad.addColorStop(1,'rgba(53,229,138,0)');
    const path=()=>pts.forEach((v,i)=>{const x=i/(pts.length-1)*w,y=h-(v-min)/(max-min)*h;i?ctx.lineTo(x,y):ctx.moveTo(x,y)});
    ctx.beginPath();path();ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
    ctx.beginPath();path();ctx.strokeStyle='#35e58a';ctx.lineWidth=2;ctx.stroke();
    const plan=plans[pair];
    if(plan&&!plan.done){
      [[plan.sl,'#ff5967'],[plan.tp1,'#35e58a'],[plan.entry,'#9ca7b6']].forEach(([v,col])=>{
        if(v<=min||v>=max)return;const y=h-(v-min)/(max-min)*h;
        ctx.strokeStyle=col;ctx.setLineDash([4,4]);ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();ctx.setLineDash([]);
      });
    }
  }catch(e){console.warn('chart',e)}
}

/* Papan kosong = tidak ada yang lolos gerbang, bukan alatnya mati. Strip ini memperlihatkan
   jarak setiap market ke kartu TERKUNCI: berapa persen countdown latch sudah jalan (hanya
   naik kalau SEMUA gerbang lolos bersamaan) dan gerbang mana yang menahan. Angka-angkanya
   dibaca dari keluaran engine yang sama seperti kartu ENTRY. Tidak ada ambang yang diubah
   di sini; yang diubah hanya kejelasan. */
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function whyEmptyHtml(rows){
  const no=v=>`<span class="whyNo">${esc(v)}</span>`,yes=v=>`<span class="whyOk">${esc(v)}</span>`;
  const list=rows.map(({pair,x})=>{
    const c=PAIRS[pair],f=x.f||{},persist=Math.max(1,x.persistMs||20000);
    const pctv=Math.max(0,Math.min(100,Math.round((x.prog||0)/persist*100)));
    const penahan=x.hard||x.blocked||(x.reason||'').split(' • ')[0].replace(/^Disaring:\s*/,'')||'—';
    return{pair,c,x,f,persist,pctv,penahan,blocked:!!(x.hard||x.blocked)};
  });
  /* yang paling siap naik ke atas: countdown lebih dulu, baru |skor| */
  list.sort((a,b)=>b.pctv-a.pctv||Math.abs(b.x.score||0)-Math.abs(a.x.score||0));
  const best=list[0];
  const head=`<div class="whyRow whyHead"><span>PAIR</span><span>SISI</span><span>SKOR</span><span>KEKUATAN</span><span>KUNCI</span><span>PENAHAN UTAMA</span><span>ATR/biaya · ER · spread</span></div>`;
  const body=list.map(r=>{
    const side=r.x.side==='UP'?'<span class="upText">BUY</span>':r.x.side==='DOWN'?'<span class="downText">SELL</span>':'<span class="whyMuted">—</span>';
    /* KEKUATAN = seberapa kuat arah BUY/SELL saat ini (upProbability/downProbability dari mesin),
       hidup/bergerak tiap evaluasi, meskipun belum ada yang terkunci. BUKAN konfirmasi/lock. */
    const strengthPct=r.x.side==='UP'?Math.round((r.x.upProbability||.5)*100)
      :r.x.side==='DOWN'?Math.round((r.x.downProbability||.5)*100):50;
    const strengthCls=strengthPct>=70?'whyOk':(strengthPct>=60?'whyMuted':'whyNo');
    const kekuatan=`<span class="${strengthCls}">${r.x.side==='UP'?'BUY':r.x.side==='DOWN'?'SELL':'—'} ${strengthPct}%</span>`;
    const bar=`<span class="whyLock"><i style="width:${r.pctv}%"></i>${r.pctv}%</span>`;
    const gp=Number.isFinite(r.x.gatesPassed)?r.x.gatesPassed:0, gt=Number.isFinite(r.x.gatesTotal)?r.x.gatesTotal:14;
    const gates=r.blocked||!r.x.f?'<span class="whyMuted">—</span>':
      (r.f.costRatio>=r.f.minCost?yes(r.f.costRatio.toFixed(1)+'× vs '+r.f.minCost+'×'):no(r.f.costRatio.toFixed(1)+'/'+r.f.minCost+'×'))+
      ' '+(r.f.er>=r.f.minER?yes('ER '+r.f.er.toFixed(2)):no('ER '+r.f.er.toFixed(2)+' < '+r.f.minER))+
      ' <span class="whyMuted">spr '+r.f.spreadPips.toFixed(1)+'p · biaya '+r.f.cost.toFixed(1)+'p · gerbang '+gp+'/'+gt+'</span>';
    const prior=Array.isArray(r.c.hours)&&r.c.hours.length?
      ` <span class="${r.x.priorOut?'whyPrior':'whyMuted'}">${r.x.priorOut?'luar':'dalam'} prior jam ${r.c.hours.join(',')} (label)</span>`:'';
    return `<div class="whyRow"><b>${r.c.name}</b>${side}<span>${r.x.status==='ok'?sgn(r.x.score):'—'}</span>${kekuatan}${bar}`+
      `<span class="${r.blocked?'whyBlk':'whyNo'}">${esc(r.penahan)}${prior}</span>${gates}</div>`;
  }).join('');
  const hint=best&&!best.blocked&&best.pctv<100?
    `<div class="whyNote">Terdekat: <b>${esc(best.c.name)}</b> — KEKUATAN ${best.x.side==='UP'?Math.round((best.x.upProbability||.5)*100):Math.round((best.x.downProbability||.5)*100)}% (arah BUY/SELL saat ini, bergerak) · KUNCI ${best.pctv}% dari ${Math.round(best.persist/1000)} detik countdown · gerbang ${Number.isFinite(best.x.gatesPassed)?best.x.gatesPassed:0}/${Number.isFinite(best.x.gatesTotal)?best.x.gatesTotal:14}. Angka KEKUATAN bukan sinyal: ia tetap terkunci hanya kalau SELURUH gerbang lolos BERSAMAAN dan bertahan sampai 100%; satu gerbang kedip = countdown berhenti. Tidak ada threshold yang diturunkan untuk memaksanya.</div>`:'';  return `<div class="whyEmpty"><div class="whyNote">0 kartu ENTRY/SETUP — feed hidup (${rows.length} pair jalan), yang menahan adalah gerbang ini. Baris diurutkan dari yang paling dekat ke TERKUNCI.</div><div class="whyNote"><b>KEKUATAN</b> = arah BUY/SELL saat ini (bergerak tiap evaluasi — bukan sinyal, bukan lock). <b>KUNCI</b> = countdown lock (0% kalau belum semua gerbang lolos bersamaan). <b>gerbang X/14</b> = berapa gerbang soft yang lolos saat ini.</div>${head}${body}${hint}</div>`;
}

function liveFeedStatusHtml(now,live,total){
  const cls=live>0?'live':'warn';
  const label=selectedFeed==='hybrid'?'Binance & Deriv Live':(selectedFeed==='binance'?'Binance Live WS':'Deriv Live WS');
  return '<span class="heroStatus '+cls+'">'+label+' · '+live+'/'+total+' pair live</span>';
}

/* ---------- main render ---------- */function render(){
  try{
    const now=Date.now();
    if(feedClosedAt!==null&&feedClosedAt!==E.closedFX(now)){console.log('[feed] bursa '+(E.closedFX(now)?'TUTUP → tinggal crypto':'BUKA → FX ikut lagi')+' — langganan feed diulang');startFeed()}
    const keys=scanKeys();
    const modeLabel=(selectedMode||'balanced').toUpperCase();
    safeText('scanModeLabel',modeLabel);
    const TF=(engines[selectedPair]?engines[selectedPair].params():EP).BAR_MIN||1;
    safeText('tfLabel',TF+'m');
    safeText('lbl1b','1×'+TF+'m');safeText('lbl3b','3×'+TF+'m');safeText('lbl15b','15×'+TF+'m');

    const rows=[];
    let live=0,alerts=0;
    const alertHtml=[],scanHtml=[];

    const WARM={stage:'WAIT',side:'WAIT',score:0,status:'warming',reason:'Engine…',upProbability:.5,downProbability:.5,
      f:null,alignment:0,alignMax:3,prog:0,persistMs:20000,sigOK:false,qualified:false,near:false,blocked:'',hard:''};
    const cards=[];
    keys.forEach(pair=>{
      const eng=engines[pair];
      const x=eng?eng.evaluate(now):WARM;
      const s=stableSignal(pair,x);
      const q=quotes[pair];
      if(q&&q.ts&&now-q.ts<caps().stale)live++;
      const show=s.stage==='ENTRY'||s.stage==='DONE'||s.confirming||(scanFilter!=='action'&&passesThreshold(pair,x,s));
      if(show)cards.push({pair,s,html:planCardHtml(pair,x,s,now),
        rank:s.stage==='ENTRY'?0:(s.stage==='DONE'?1:(s.confirming?2:3))});
      scanHtml.push(scanRowHtml(pair,x,s,now));
      rows.push({pair,x,s});
    });
    // ENTRY paling atas, lalu countdown, lalu kandidat threshold — urutannya tidak berubah-ubah lagi
    cards.sort((a,b)=>a.rank-b.rank||(a.pair<b.pair?-1:1));
    alerts=cards.length;
    alertHtml.push(...cards.map(c=>c.html));

    // Focus pair detail
    const focus=rows.find(r=>r.pair===selectedPair)||rows[0];
    const fx=focus?focus.x:{stage:'WAIT',side:'WAIT',score:0,status:'warming',reason:'—',f:null,alignment:0,alignMax:3,upProbability:.5,r1m:null};
    const fs=focus?focus.s:signalStates[selectedPair]||{stage:'WAIT',side:'WAIT',reason:'—',confirming:false,generatedAt:0};
    const fq=quotes[selectedPair]||{bid:0,ask:0,last:0,ts:0};
    const c=pairCfg(selectedPair),dp=c.dp,f=fx.f;
    const fresh=!!(fq.ts&&now-fq.ts<caps().stale);

    renderFocusPlan(fs,fx,now);
    drawChart(selectedPair);

    safeText('marketTitle',fxClosed()?'BURSA FX TUTUP · hanya BTC & ETH yang dipindai':(keys.length+' pair · '+caps().label));
    safeText('scanLiveCount',String(live)+'/'+keys.length);
    safeText('scanAlertCount',String(alerts));
    safeText('binanceFeed',fq.ts?Math.max(0,now-fq.ts)+'ms':'—');
    safeText('feedLabel',caps().label+' · multi');
    safeSetClass('binanceDot',fresh||live>0?'live':'warn');

    setBoard('alertBoard',alertHtml.length?alertHtml.join(''):whyEmptyHtml(rows));
    setBoard('scanBoard','<div class="scanHead"><span>PAIR</span><span>STAGE</span><span>SIDE</span><span>SCORE</span><span>MID</span><span>AGE</span></div>'+scanHtml.join(''));

    safeText('spotPrice',fq.last?fq.last.toFixed(dp):'—');
    safeText('lastPrice',fq.last?fq.last.toFixed(dp):'—');
    safeText('binanceBid',fq.bid?fq.bid.toFixed(dp):'—');
    safeText('binanceAsk',fq.ask?fq.ask.toFixed(dp):'—');
    safeText('chartFeed',fq.ts?Math.max(0,now-fq.ts)+'ms':'—');
    safeText('chartTitle',c.name);
    safeText('spotSignal',fx.status==='ok'?(fx.side||'WAIT'):'WAIT');
    safeText('ret1s',fx.r1m!=null?fmtPct(fx.r1m):'—');
    safeText('ret3s',fx.r3m!=null?fmtPct(fx.r3m):'—');
    safeText('ret5s',fx.r15m!=null?fmtPct(fx.r15m):'—');
    safeText('factorMomentum',f?sgn(f.mom):'—');
    safeText('factorFlow',f&&f.flowOK?sgn(f.flow):(f&&f.htf!=null?('htf '+sgn(f.htf)):'n/a'));
    safeText('factorPoly',f?sgn(f.trend):'—');
    safeText('factorRsi',f?(f.brk!=null?('brk '+sgn(f.brk)+' · ER '+f.er.toFixed(2)):f.er.toFixed(2)):'—');
    safeText('modelScore',fx.status==='ok'?sgn(fx.score*100,0):'—');
    safeText('volatility',f?f.atrP.toFixed(1)+' pips':'—');
    safeText('bidEdge',f?f.costRatio.toFixed(1)+'×':'—');
    safeText('alignment',(fx.alignment||0)+'/'+(fx.alignMax||3));

    safeSetClass('sniperBox','sniper '+String(fs.stage).toLowerCase());
    safeText('sniperText',(fs.stage==='ENTRY'?'⚡':fs.stage==='SETUP'?'🎯':'👀')+' '+fs.stage);
    safeText('sniperSub',(fs.reason||'')+' • '+fmtTime(fs.generatedAt));

    const mine=storedEntries.filter(e=>typeof e.resultR==='number');
    const S=E.summarize(mine.map(e=>({resultR:e.resultR})));
    safeText('sniperWins',String(S.wins));
    safeText('sniperLosses',String(S.n-S.wins));
    safeText('sniperWinRate',S.n?(S.winRate*100).toFixed(1)+'%':'—');
    safeText('probAccuracy',S.n?fmtR(S.avgR):'—');
    safeText('upProbAccuracy',S.n?fmtR(S.totalR)+' ('+S.n+')':'—');
    safeText('downProbAccuracy',S.n?('PF '+(S.pf===Infinity?'∞':S.pf==null?'—':S.pf.toFixed(2))+' • DD '+S.maxDD.toFixed(1)+'R'):'—');

    const hist=historyEntries.slice(0,40);
    safeHTML('entryHistory',hist.length?hist.map(h=>'<div class="historyRow"><b>'+(h.pair||'')+' '+h.side+'</b><span>'+fmtTime(h.generatedAt)+'</span><span>'+(typeof h.resultR==='number'?(h.outcome+' • '+fmtR(h.resultR)):('BERJALAN'))+'</span></div>').join(''):'<div class="historyEmpty">Belum ada entry terkunci.</div>');

    const warn=S.n<30?' • Sampel '+S.n+'/30':'';
    safeHTML('recentResults','<span class="historyEmpty">'+(feedNote||'Informational only')+warn+' • '+caps().short+' = '+keys.length+' pair'+'</span>');
    safeText('status',live?('LIVE multi · '+live+'/'+keys.length+' · '+caps().short+' · '+fmtTime(now)):('WAITING FEED'+(feedNote?' — '+feedNote:'')+(fxClosed()?' • MARKET CLOSED':'')));
    safeHTML('aitermSnapshot', liveFeedStatusHtml(now,live,keys.length));
  }catch(err){console.error('render',err&&err.stack||err)}
}

/* ---------- STATISTIK PER PASANGAN ----------
   Dua angka yang berbeda dan sengaja tidak digabung:
     REPLAY   = engine yang sama di atas data tick historis lokal (tools/pair_stats.js
                → stats/pair_stats.json). Ini jawaban "winrate tiap pair bagus atau jelek".
     LIVE     = plan yang benar-benar terkunci lalu selesai di tab ini (storedEntries).
   Keduanya dinilai mesin yang sama (engine.js manage/summarize), jadi selisihnya informatif,
   bukan duplikasi. Pair tanpa file data dicatat TANPA DATA — bukan 0 trade, karena 0 trade
   akan terbaca sebagai "jelek" padahal yang belum diuji adalah datanya. */
const SAMPLE_MIN=30, PF_MIN=1.1;   // ambang yang sama dipakai backtest.js dan walkforward.js untuk "layak dipercaya"

/* Badge saja: informasi statistik replay di kartu sinyal. Tidak menjadi filter/gerbang —
   sinyal tetap tampil, operator yang menilai. Tooltip menegaskan sumbernya berbeda dari live feed. */
function pairStatChip(pair){
  const mode=(typeof selectedMode==='string'&&selectedMode)||'balanced';
  const s=pairStats&&pairStats.pairs&&pairStats.pairs[pair]&&pairStats.pairs[pair].modes&&pairStats.pairs[pair].modes[mode];
  if(!s||!s.n)return '<span class="statChip none" title="Belum ada hasil replay untuk pair dan mode ini.">STAT —</span>';
  const v=verdictOf(s);
  if(v.k==='none')return '<span class="statChip thin" title="Sampel replay di bawah '+SAMPLE_MIN+'; angka belum berarti.">SAMPEL '+s.n+'/'+SAMPLE_MIN+'</span>';
  const wr=pc(s.winRate),avg=fmtR(s.avgR),pf=nf(s.pf);
  return '<span class="statChip '+v.k+'" title="Statistik replay '+(pairStats.generatedAt?('('+new Date(pairStats.generatedAt).toLocaleString()+') '):'')+'berasal dari data/feed lama (PAXGUSDT/USDT & Deriv), bukan feed live aiterminaltrading. n='+s.n+', WR '+wr+', avgR '+avg+', PF '+pf+'. Informasi saja; tidak memblokir atau mengubah sinyal.">'+
    v.t+' · n='+s.n+' · WR '+wr+'</span>';
}
let pairStats=null,pairStatsNote='';

async function loadPairStats(){
  safeHTML('pairStatsSrc','Memuat data uji…');
  try{
    const r=await fetch('stats/pair_stats.json?v='+Math.floor(Date.now()/600000),{cache:'no-store'});
    if(!r.ok)throw new Error('HTTP '+r.status);
    pairStats=await r.json();
  }catch(e){
    pairStats=null;
    pairStatsNote='stats/pair_stats.json belum ada — buat sekali dengan <b>node tools/pair_stats.js</b> (±20 menit, semua pair × semua mode; satu mode ±3 menit).';
  }
  /* Chip statistik dirender dari data yang sama; gambar ulang setelah stats terbaca. */
  try{ render(); }catch(e){ console.warn('[stats] render setelah loadPairStats gagal', e); }
  renderPairStats();
}

/* ---------- daemon 24/7 (tools/collector.js) ----------
   Yang dibaca adalah LEDGER-nya (satu baris JSON per plan yang selesai), bukan ringkasannya.
   Alasannya: menggabungkan dua ringkasan menghasilkan rata-rata dari rata-rata — maxDD, PF dan
   Sharpe tidak bisa diturunkan dari angka gabungan. Dengan baris mentahnya, panel menghitung
   ulang lewat E.summarize yang sama seperti menghitung ledger tab ini. live_stats.json hanya
   dipakai untuk satu baris status: apakah daemon-nya masih hidup. */
let daemon=null,daemonRows=[];
const stamp=()=>Math.floor(Date.now()/600000);

async function loadDaemon(){
  try{
    const [l,s]=await Promise.all([
      fetch('stats/live_ledger.jsonl?v='+stamp(),{cache:'no-store'}),
      fetch('stats/live_stats.json?v='+stamp(),{cache:'no-store'})
    ]);
    daemonRows=l.ok?String(await l.text()).split('\n').map(x=>x.trim()).filter(Boolean)
      .map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(x=>x&&x.id&&typeof x.resultR==='number'):[];
    daemon=s.ok?await s.json():null;
  }catch(e){daemon=null;daemonRows=[]}   /* daemon belum jalan = keadaan normal, bukan error */
  renderPairStats();
}

/* Plan yang sama bisa tercatat di dua tempat kalau tab sempat terbuka saat daemon juga
   melihatnya. id plan dari engine sudah unik (pair|waktu|sisi), jadi dedup cukup lewat id. */
function allClosed(mode){
  const byId=new Map();
  for(const r of daemonRows)if(!mode||r.mode===mode)byId.set(r.id,
    {pair:r.pair,side:r.side,resultR:r.resultR,mfe:r.mfe,mae:r.mae,t:r.t,closedAt:r.closedAt,done:r.done,src:'daemon'});
  /* Ledger tab tidak menyimpan mode, jadi barisnya ikut di semua mode — itu sebabnya
     sumbernya selalu disebut terpisah, bukan dilebur diam-diam. */
  for(const e of storedEntries)if(e.pair&&typeof e.resultR==='number'&&!byId.has(e.id))byId.set(e.id,
    {pair:e.pair,side:e.side,resultR:e.resultR,mfe:e.mfe,mae:e.mae,t:e.generatedAt,closedAt:e.closedAt,done:e.outcome,src:'tab'});
  return Array.from(byId.values());
}

function verdictOf(s){
  if(!s||!s.n)return{k:'none',t:'TANPA DATA'};
  if(s.n<SAMPLE_MIN)return{k:'none',t:'SAMPEL '+s.n+'/'+SAMPLE_MIN};
  const pf=s.pf==null?0:s.pf;
  if(s.avgR>0&&pf>=PF_MIN)return{k:'good',t:'BAGUS'};
  if(s.avgR>0||pf>=1)return{k:'marginal',t:'MARGINAL'};
  return{k:'bad',t:'JELEK'};
}

function outcomeNote(s){
  if(!s||!s.n)return '—';
  const top=Object.keys(s.outcome||{}).sort((a,b)=>s.outcome[b]-s.outcome[a]);
  const hit=top.length?top[0]+' '+s.outcome[top[0]]+'/'+s.n:'—';
  const dir=s.dirMiss==null?'':' • rugi tanpa pernah +0,5R: '+(s.dirMiss*100).toFixed(0)+'%';
  const geo=s.geoMiss==null?'':' • rugi padahal pernah ≥1R: '+(s.geoMiss*100).toFixed(0)+'%';
  return hit+dir+geo;
}

const pc=v=>v==null?'—':(v*100).toFixed(1)+'%';
const nf=(v,d=2)=>typeof v!=='number'||isNaN(v)?'—':(isFinite(v)?v.toFixed(d):'∞');

function pairRowHtml(name,s,extra){
  const v=verdictOf(s);
  return '<div class="pairRow '+v.k+'"><b>'+name+'</b>'+
    '<s>'+(s&&s.n?s.n:'0')+'</s>'+
    '<s>'+(s&&s.n?pc(s.winRate):'—')+'</s>'+
    '<i>'+fmtR(s&&s.n?s.avgR:null)+'</i>'+
    '<i>'+fmtR(s&&s.n?s.totalR:null)+'</i>'+
    '<i>'+nf(s&&s.n?s.pf:null)+'</i>'+
    '<u>'+(s&&s.n?'−'+nf(s.maxDD,1)+'R':'—')+'</u>'+
    '<em>'+(extra||'')+((s&&s.n)?' • hold ✓'+nf(s.holdWin,0)+'m / ✗'+nf(s.holdLoss,0)+'m':'')+'</em>'+
    '<span class="vTag '+v.k+'">'+v.t+'</span></div>';
}

const PAIR_HEAD='<div class="pairHead"><span>PASANGAN</span><span>N</span><span>WINRATE</span><span>avgR</span><span>TOTAL R</span><span>PF</span><span>maxDD</span><span>KELUAR DOMINAN & DIAGNOSIS</span><span>VONIS</span></div>';

/* ---------- winrate per jam UTC (replay + live) ----------
   Jam dihitung dari WAKTU MASUK sinyal, bukan waktu keluar. Ambang per jam sengaja
   lebih longgar dari ambang pair: satu jam hanya menampung ±1/24 sampel, jadi syarat
   30 trade per pair tidak akan pernah tercapai dan seluruh tabel akan berbunyi "tipis". */
const HOUR_MIN=20;

function hourAgg(mode){
  const b=Array.from({length:24},(_,i)=>({h:i,n:0,w:0,g:0,l:0,rep:0,liv:0}));
  const byPair={};
  const P=(pairStats&&pairStats.pairs)||{};
  for(const k of Object.keys(P)){
    const H=(P[k].modes[mode]||{}).hours||{};
    for(const hk of Object.keys(H)){
      const x=H[hk],i=+hk;if(!(x&&i>=0&&i<24))continue;
      const o=b[i];o.n+=x.n||0;o.w+=x.w||0;o.g+=x.g||0;o.l+=x.l||0;o.rep+=x.n||0;
      byPair[k]=(byPair[k]||0)+(x.n||0);
    }
  }
  /* Ledger gabungan: daemon 24/7 + plan yang selesai di tab ini. Keduanya dihitung dari
     jam masuk sinyal, sama seperti kolom hours hasil replay. */
  for(const e of allClosed(mode)){
    if(!e.t)continue;
    const o=b[new Date(e.t).getUTCHours()];if(!o)continue;
    o.n++;if(e.resultR>0){o.w++;o.g+=e.resultR}else o.l-=e.resultR;o.liv++;
  }
  return Object.assign(b,{byPair});
}

function hourVerdict(x){
  if(!x.n)return{k:'none',t:'—'};
  if(x.n<HOUR_MIN)return{k:'thin',t:'tipis'};
  const avg=(x.g-x.l)/x.n,pf=x.l>0?x.g/x.l:(x.g>0?Infinity:null);
  if(avg>0&&pf>=PF_MIN)return{k:'good',t:'BAGUS'};
  if(avg>0||pf>=1)return{k:'marginal',t:'MARGINAL'};
  return{k:'bad',t:'JELEK'};
}

function renderHourBoard(mode){
  const b=hourAgg(mode);
  const cells=b.map(x=>{
    const wr=x.w/x.n,avg=(x.g-x.l)/x.n,v=hourVerdict(x);
    return '<div class="hourCell '+v.k+'"><b>'+String(x.h).padStart(2,'0')+':00</b>'+
      '<s>'+(x.n?pc(wr):'—')+'</s><i>'+fmtR(x.n?avg:null)+'</i>'+
      '<u>'+(x.n?('n '+x.n+(x.liv?' • '+x.liv+' live':'')+' • PF '+nf(x.l>0?x.g/x.l:(x.g>0?Infinity:null))):'0 trade')+'</u></div>';
  }).join('');
  setBoard('hourBoard','<div class="hourHead"><span>JAM UTC</span><span>WINRATE</span><span>avgR</span><span>SAMPEL</span></div>'+cells);
  const rated=b.filter(x=>x.n>=HOUR_MIN).map(x=>({x,avg:(x.g-x.l)/x.n}));
  let note;
  if(!rated.length){
    note='Belum ada satu jam pun dengan ≥'+HOUR_MIN+' trade'+(pairStats?' pada mode ini':'')+' — tiap sel di atas masih anekdot, bukan pola per jam.';
  }else{
    const best=rated.reduce((a,y)=>y.avg>a.avg?y:a,rated[0]),worst=rated.reduce((a,y)=>y.avg<a.avg?y:a,rated[0]);
    const thin=b.filter(x=>x.n&&x.n<HOUR_MIN).length;
    note='Terbaik <b>'+String(best.x.h).padStart(2,'0')+':00 UTC</b> ('+fmtR(best.avg)+'/trade, n='+best.x.n+') · terburuk <b>'+
      String(worst.x.h).padStart(2,'0')+':00 UTC</b> ('+fmtR(worst.avg)+'/trade, n='+worst.x.n+') · '+
      rated.length+'/24 jam punya sampel cukup, '+thin+' jam terlalu tipis, '+(24-rated.length-thin)+' jam kosong.';
  }
  const tot=Object.values(b.byPair).reduce((a,x)=>a+x,0),dom=Object.keys(b.byPair).sort((a,c)=>b.byPair[c]-b.byPair[a])[0];
  safeHTML('hourNote','<div class="statsWarn">'+note+
    '<br>Per jam hanya <b>avgR dan PF kasar</b> yang dinilai — drawdown maksimum tidak berlaku untuk pecahan 1/24 data. Jam = waktu sinyal masuk, dihitung dari semua pair yang punya data'+
    (b.some(x=>x.liv)?' ditambah ledger tab ini (semua mode, tanpa pemisah mode)':'')+'.'+
    (tot&&dom?'<br>Sampel campuran ini didominasi <b>'+(E.PAIRS[dom]?E.PAIRS[dom].name:dom)+'</b>: '+b.byPair[dom]+'/'+tot+' trade ('+
      (b.byPair[dom]/tot*100).toFixed(0)+'%), jadi "jam terbaik" di atas lebih dekat ke pola pair itu daripada pola pasar global.':'')+'</div>');
}

function renderPairStats(){
  const mode=selectedMode, mc=E.MODES[mode]||{};
  safeText('pairStatsMode','mode '+String(mode).toUpperCase()+' • threshold skor ≥'+(mc.minScore??'—')+' • minCost '+(mc.minCost??'—')+'R');
  renderHourBoard(mode);
  if(!pairStats){
    /* Tanpa berkas hasil replay sekalipun tabel tetap menampilkan SEMUA pair yang dipindai.
       Daftar yang diam-diam menyusut lebih berbahaya daripada daftar kosong: tidak ada bedanya
       antara "pair ini jelek" dan "pair ini belum pernah diuji". */
    safeHTML('pairStatsSrc',pairStatsNote||'—');
    setBoard('pairStatsBoard',PAIR_HEAD+Object.keys(E.PAIRS).map(k=>pairRowHtml(E.PAIRS[k].name,null,'belum diuji')).join(''));
    safeHTML('pairStatsVerdict','<div class="statsWarn">Belum ada hasil replay. Jalankan <b>node tools/pair_stats.js</b> untuk membuat stats/pair_stats.json, lalu muat ulang halaman ini.</div>');
  }else{
    const gen=new Date(pairStats.generatedAt);
    const rows=Object.keys(E.PAIRS).map(k=>{
      const P=pairStats.pairs[k];
      if(!P)return pairRowHtml(E.PAIRS[k].name,null,(pairStats.missing||[]).find(m=>m.pair===k)?.reason||'tidak diuji');
      const s=P.modes[mode];
      const extra=s
        ? (P.window&&P.window.days?'±'+P.window.days+' hari • ':'')+outcomeNote(s)
        : 'mode '+String(mode).toUpperCase()+' belum ada di pair_stats.json — jalankan node tools/pair_stats.js';
      return pairRowHtml(P.name+' <em>'+P.symbol+'</em>',s,extra);
    }).join('');
    const tested=Object.keys(pairStats.pairs).length;
    setBoard('pairStatsBoard',PAIR_HEAD+rows);
    const win=pairStats.pairs, bad=[],good=[],thin=[];
    Object.keys(E.PAIRS).forEach(k=>{
      const s=win[k]&&win[k].modes&&win[k].modes[mode];const v=verdictOf(s);
      if(v.t==='BAGUS')good.push(E.PAIRS[k].name);else if(v.t==='JELEK')bad.push(E.PAIRS[k].name);else if(s&&s.n)thin.push(E.PAIRS[k].name);
    });
    safeHTML('pairStatsSrc','Replay dibuat '+gen.toLocaleString()+' • engine meniru TP1 1:'+E.PARAMS.TP1_R+' / TP2 1:'+E.PARAMS.TP2_R+' dengan 50% ditutup di TP1, SL dinamis ATR×'+E.PARAMS.SL_ATR_MULT+', time-stop '+Math.round(E.PARAMS.PLAN_TTL/60000)+' mnt • spread broker sudah dihitung, slippage/komisi TIDAK • '+
      tested+' pair punya data uji, '+(pairStats.missing||[]).length+' pair tidak punya sumber data lokal.');
    safeHTML('pairStatsVerdict',
      '<div class="statsWarn">'+
        (good.length?'<b>BAGUS</b> ('+good.length+'): '+good.join(', ')+'<br>':'')+
        (bad.length?'<b>JELEK</b> ('+bad.length+'): '+bad.join(', ')+'<br>':'')+
        (thin.length?'<b>SAMPEL KECIL</b> ('+thin.length+'): '+thin.join(', ')+' — angkanya belum berarti<br>':'')+
        (!good.length&&!bad.length?'Belum ada pair yang bisa dinilai pada mode ini — sampel belum cukup atau datanya belum dibuat.<br>':'')+
        'Ambang vonis: ≥'+SAMPLE_MIN+' trade DAN (avgR&gt;0 dengan PF ≥'+PF_MIN+') = BAGUS; avgR ≤ 0 dengan PF &lt; 1 = JELEK. Di bawah '+SAMPLE_MIN+' trade, winrate hanyalah anekdot.'+
      '</div>');
  }

  /* --- catatan live per pair: daemon 24/7 + ledger tab ini, dihitung ulang di sini --- */
  const done=allClosed(mode),byPair={};
  for(const e of done)(byPair[e.pair]=byPair[e.pair]||[]).push(e);
  const lk=Object.keys(E.PAIRS).filter(k=>byPair[k]);
  const src={};for(const e of done)src[e.src]=(src[e.src]||0)+1;
  /* Ternary wajib dikurung di sini: `kondisi?a:'x' + b` menambah b hanya ke cabang palsu. */
  const age=daemon&&daemon.counters?(() => {const s=daemon.counters.lastTickAgeS||0;
    return s<90?s.toFixed(0)+' dtk':(s/60).toFixed(1)+' mnt'})():'';
  /* Ringkasan ditulis ulang tiap detak jantung (5 mnt) dan tiap plan selesai. Lewat 10 menit
     berarti collector-nya tidak sedang jalan — menyebutnya "aktif" hanya karena berkasnya
     ada akan menyajikan angka basi sebagai data hidup. */
  const fresh=daemon&&daemon.generatedAt?(Date.now()-Number(daemon.generatedAt))/1000:null;
  const alive=fresh!=null&&fresh<=600;
  safeText('livePairSrc',((src.daemon||src.tab)?'Sumber: '+[src.daemon?src.daemon+' plan dari daemon 24/7':null,
    src.tab?src.tab+' plan dari tab ini':null].filter(Boolean).join(' + '):'Sumber: tab ini')+
    (daemon&&daemon.counters?' • '+(alive?'daemon aktif '+((daemon.uptimeMin||0)/60).toFixed(1)+' jam, '+
      nf(daemon.counters.ticks,0)+' tick, umur data '+age
      :'ringkasan terakhir ditulis '+new Date(Number(daemon.generatedAt)).toLocaleString()+
        ' — collector.js tidak berjalan, angka di atas tidak akan bertambah'):''));
  setBoard('livePairBoard',lk.length?PAIR_HEAD+lk.map(k=>{
    const s=E.summarize(byPair[k]);
    const oc={};for(const t of byPair[k])oc[t.done]=(oc[t.done]||0)+1;
    const first=byPair[k].reduce((a,e)=>Math.min(a,e.t||Infinity),Infinity),last=byPair[k].reduce((a,e)=>Math.max(a,e.t||0),0);
    return pairRowHtml(E.PAIRS[k].name+' <em>live</em>',Object.assign({},s,{outcome:oc}),
      'sejak '+new Date(first).toLocaleDateString()+' • terakhir '+new Date(last).toLocaleDateString()+' • '+
      Object.keys(oc).sort((a,b)=>oc[b]-oc[a])[0]+' '+oc[Object.keys(oc).sort((a,b)=>oc[b]-oc[a])[0]]+'/'+s.n);
  }).join(''):'<div class="historyEmpty">Belum ada plan yang selesai. Jalankan <b>node tools/collector.js</b> supaya sampel terkumpul walau tab tertutup — angkanya akan muncul sendiri di sini.</div>');
}

/* ---------- storage ---------- */
function saveAll(){
  try{
    const prev=JSON.parse(localStorage.getItem(STORE)||'{}');
    prev.sniperEntries=storedEntries.slice(-500);
    prev.settings=settings;
    prev.plans=plans;
    localStorage.setItem(STORE,JSON.stringify(prev));
  }catch{}
}
async function loadCalibration(){
  try{
    let z=JSON.parse(localStorage.getItem(STORE)||'null');
    if(!z){const old=JSON.parse(localStorage.getItem('fxSniper')||'{}');z={settings:old.settings}}
    storedEntries=Array.isArray(z.sniperEntries)?z.sniperEntries:[];
    settings=Object.assign(settings,z.settings||{});
    if(z.plans&&typeof z.plans==='object')Object.assign(plans,z.plans);
    historyEntries.splice(0,historyEntries.length,...storedEntries.filter(x=>x.stage==='ENTRY').slice(-60).reverse());
  }catch(e){console.warn('load',e)}
}
async function persistEntry(h){
  if(storedEntries.some(x=>x.id===h.id))return;
  storedEntries.push(Object.assign({result:null,correct:null,resultR:null},h));
  storedEntries=storedEntries.slice(-500);
  historyEntries.unshift(storedEntries[storedEntries.length-1]);
  historyEntries.splice(60);
  saveAll();
}
function closeRow(tr){
  const row=storedEntries.find(e=>e.id===tr.id);if(!row)return;
  row.resultR=tr.resultR;row.outcome=tr.done;row.closedAt=tr.closedAt;
  row.correct=tr.resultR>0;row.result=tr.resultR>0?tr.side:(tr.side==='UP'?'DOWN':'UP');
  saveAll();
}

function exportTicks(){
  if(rec.length<10){alert('Belum ada tick.');return}
  const csv='ts,pair,bid,ask\n'+rec.map(r=>r.join(',')).join('\n');
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));
  a.download='ticks_multi_'+selectedFeed+'_'+new Date().toISOString().slice(0,16).replace(/[:T]/g,'')+'.csv';
  document.body.appendChild(a);a.click();a.remove();
}

function initPlanInputs(){
  const bal=$('planBalance'),rk=$('planRisk'),cp=$('planCopy');
  if(bal){bal.value=settings.balance;bal.oninput=()=>{settings.balance=N(bal.value);saveAll()}}
  if(rk){rk.value=settings.riskPct;rk.oninput=()=>{settings.riskPct=N(rk.value);saveAll()}}
  if(cp)cp.onclick=async()=>{
    if(!planText)return;
    try{await navigator.clipboard.writeText(planText);cp.textContent='COPIED'}catch{cp.textContent='GAGAL'}
    setTimeout(()=>{cp.textContent='COPY PLAN'},1500);
  };
}

function focusPair(pair){
  if(!PAIRS[pair])return;
  selectedPair=pair;lsSet('fxSniperPair',pair);
  const ps=$('pairSelect');if(ps)ps.value=pair;
  render();
}

(function bindUI(){
  const r=$('refresh');if(r)r.onclick=()=>{startFeed();render()};
  const c=$('clear');if(c)c.onclick=()=>{
    if(!confirm('Hapus semua riwayat entry?'))return;
    storedEntries=[];historyEntries.length=0;saveAll();render();renderPairStats();
  };
  const ex=$('exportTicks');if(ex)ex.onclick=exportTicks;
  const st=$('statsToggle');
  if(st)st.onclick=()=>{
    const e=$('statsDetails'),b=$('statsToggle');
    if(!e||!b)return;
    e.classList.toggle('hiddenStats');
    b.textContent=e.classList.contains('hiddenStats')?'SHOW STATS':'HIDE STATS';
  };
  const fs=$('feedSelect');
  if(fs){fs.value=selectedFeed;fs.onchange=e=>{selectedFeed=e.target.value;lsSet('fxSniperFeed',selectedFeed);startFeed();render()}}
  const ms=$('modeSelect');
  if(ms){ms.value=selectedMode;ms.onchange=e=>{
    selectedMode=e.target.value;lsSet('fxSniperMode',selectedMode);
    Object.values(engines).forEach(eng=>eng.setMode(selectedMode));
    renderPairStats();
  }}
  const sf=$('scanFilter');
  if(sf){sf.value=scanFilter;sf.onchange=e=>{scanFilter=e.target.value;lsSet('fxSniperFilter',scanFilter);render()}}
  const ps=$('pairSelect');
  if(ps){ps.value=selectedPair;ps.onchange=e=>focusPair(e.target.value)}

  document.addEventListener('click',ev=>{
    const row=ev.target.closest('[data-pair]');
    if(!row)return;
    const pair=row.getAttribute('data-pair');
    if(ev.target.classList.contains('copyOne')||ev.target.closest('.copyOne')){
      const p=plans[pair]&&!plans[pair].done?plans[pair]:(engines[pair]&&signalStates[pair]&&signalStates[pair].confirming?engines[pair].preview(signalStates[pair].side):null);
      const txt=buildCopyText(pair,p);
      if(txt)navigator.clipboard.writeText(txt).catch(()=>{});
      focusPair(pair);
      return;
    }
    focusPair(pair);
  });
})();

(async()=>{
  console.log('[app] boot multi-scanner');
  await loadCalibration();
  initPlanInputs();
  refreshNews();
  startFeed();
  render();
  renderPairStats();
  loadPairStats();
  loadDaemon();
  setInterval(loadDaemon,60000);   /* ledger daemon ditulis terus; 60 detik cukup, tidak perlu secepat render */
  setInterval(render,500);
  console.log('[app] boot done — feed',selectedFeed,'mode',selectedMode);
})();
