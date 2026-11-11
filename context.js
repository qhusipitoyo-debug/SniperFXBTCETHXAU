/* Konteks Pasar Bersama: Kalender Ekonomi + Sentimen Pasar (UMD — dipakai app.js & tools/collector.js) */
(function(root){
'use strict';

const CCY_MAP={
  'UNITED STATES':'USD','US':'USD','USA':'USD',
  'CANADA':'CAD','CA':'CAD',
  'EUROZONE':'EUR','EURO AREA':'EUR','EMU':'EUR',
  'UK':'GBP','UNITED KINGDOM':'GBP','GB':'GBP',
  'JAPAN':'JPY','JP':'JPY',
  'AUSTRALIA':'AUD','AU':'AUD',
  'NEW ZEALAND':'NZD','NZ':'NZD',
  'SWITZERLAND':'CHF','CH':'CHF'
};

function newsCountryCode(c){
  const u=String(c||'').trim().toUpperCase();
  return CCY_MAP[u]||u;
}

function parseImpact(v){
  if(typeof v==='number'&&Number.isFinite(v))return Math.max(1,Math.min(3,Math.round(v)));
  const s=String(v||'').trim().toLowerCase();
  if(!s)return 1;
  if(s==='3'||s.includes('high')||s.includes('merah'))return 3;
  if(s==='2'||s.includes('med')||s.includes('orange')||s.includes('kuning'))return 2;
  if(s==='0'||s.includes('holiday')||s.includes('libur'))return 0;
  return 1;
}

function newsNum(v){
  if(v===null||v===undefined||String(v).trim()===''||v==='-'||v==='—')return null;
  const raw=String(v).trim().replace(/,/g,'');
  const m=raw.match(/^([+-]?\d*\.?\d+)\s*([KMB])?%?$/i);
  let n;let suf='';
  if(m){n=Number(m[1]);suf=(m[2]||'').toUpperCase();}
  else n=Number(raw.replace(/[^0-9.-]/g,''));
  if(!Number.isFinite(n))return null;
  if(suf==='K')n*=1e3;if(suf==='M')n*=1e6;if(suf==='B')n*=1e9;
  return n;
}

function newsNormalize(e){
  if(!e)return null;
  const ts=e.ts!=null?Number(e.ts):Date.parse(e.Date||e.date||e.time||'');
  if(!Number.isFinite(ts))return null;
  const imp=parseImpact(e.Importance??e.importance??e.impact);
  return {
    ts,
    Date:new Date(ts).toISOString(),
    Event:String(e.Event||e.event||e.title||e.Category||'Economic release').trim(),
    Country:newsCountryCode(e.Country||e.country||e.currency),
    Importance:imp,
    Forecast:e.Forecast!=null?String(e.Forecast):(e.forecast!=null?String(e.forecast):(e.TEForecast!=null?String(e.TEForecast):'')),
    Previous:e.Previous!=null?String(e.Previous):(e.previous!=null?String(e.previous):''),
    Actual:e.Actual!=null?String(e.Actual):(e.actual!=null?String(e.actual):'')
  };
}

function newsAffectsPair(e,pair){
  const c=newsCountryCode(e.Country||e.country);
  if(!c)return false;
  if(c==='USD')return true;
  if(pair.length===6&&(pair.slice(0,3)===c||pair.slice(3,6)===c))return true;
  return false;
}

function newsGoldBias(name,surprise,country){
  const laborSoft=/unemployment rate|unemployment|initial claims|continuing claims|jobless claims|jobless/.test(name);
  const proCcyIfHigh=/cpi|inflation|pce|pmi|ism|retail sales|consumer confidence|fed funds|interest rate|rate decision|jolts|durable goods|nonfarm payroll|non-farm payroll|nfp|payroll|gdp|adp|employment|wage|ppi/.test(name);
  if(country==='USD'){
    if(laborSoft)return surprise>0;
    if(proCcyIfHigh)return surprise<0;
    return null;
  }
  if(laborSoft)return surprise<0;
  if(proCcyIfHigh)return surprise>0;
  return null;
}

function newsAnalyze(e){
  const name=String(e.Event||'').toLowerCase();
  const country=newsCountryCode(e.Country);
  const forecast=newsNum(e.Forecast),actual=newsNum(e.Actual);
  const impact=+e.Importance||1;
  if(actual===null||forecast===null)return {dir:'wait',score:Math.max(35,48-impact*2),reason:'Menunggu rilis Actual vs Forecast'};
  const surprise=actual-forecast;
  const threshold=Math.max(Math.abs(forecast)*0.005,0.01);
  if(Math.abs(surprise)<threshold)return {dir:'wait',score:45,reason:'Actual sesuai ekspektasi'};
  const ccySignal=newsGoldBias(name,surprise,country);
  if(ccySignal===null)return {dir:'wait',score:40,reason:'Dampak netral/tidak terpetakan'};
  const strength=Math.min(40,Math.round(Math.abs(surprise)/threshold*10));
  return {
    dir:ccySignal?'long':'short',
    score:Math.min(95,Math.max(55,55+strength)),
    reason:`Actual ${actual} vs Forecast ${forecast}`
  };
}

function mapCcyDirToPair(pair,country,analyzeDir){
  if(analyzeDir!=='long'&&analyzeDir!=='short')return null;
  const c=newsCountryCode(country);
  if(c==='USD'){
    // Untuk USD: analyzeDir='long' berarti USD melemah (bullish XAU/EURUSD)
    const usdWeak=analyzeDir==='long';
    if(pair.startsWith('USD'))return usdWeak?'DOWN':'UP';
    return usdWeak?'UP':'DOWN';
  }
  // Untuk mata uang non-USD (EUR, GBP, JPY, AUD, NZD, CAD, CHF): 'long' berarti mata uang c menguat
  const ccyStrong=analyzeDir==='long';
  if(pair.startsWith(c))return ccyStrong?'UP':'DOWN';
  if(pair.length===6&&pair.endsWith(c))return ccyStrong?'DOWN':'UP';
  return null;
}

function newsBias(events,pair,now,getPrePrice,curPrice){
  if(!Array.isArray(events)||!events.length)return null;
  const cands=events
    .filter(e=>e&&(e.Importance||1)>=2&&newsAffectsPair(e,pair)&&Number.isFinite(e.ts))
    .sort((a,b)=>a.ts-b.ts);
  if(!cands.length)return null;

  // Jendela pasca-rilis terkalibrasi: High=45m, Medium=20m (tidak lagi 6 jam!)
  const released=cands.filter(e=>{
    const win=(e.Importance>=3?45:20)*60000;
    return e.ts<=now&&(now-e.ts)<=win;
  });
  if(released.length){
    const pick=released[released.length-1];
    const win=(pick.Importance>=3?45:20)*60000;
    const a=newsAnalyze(pick);
    let pairDir=mapCcyDirToPair(pair,pick.Country,a.dir);
    if(!pairDir&&typeof getPrePrice==='function'&&curPrice>0){
      const base=getPrePrice(pick,pair);
      if(base>0){
        const chg=(curPrice-base)/base*100;
        if(Math.abs(chg)>=0.08)pairDir=chg>0?'UP':'DOWN';
      }
    }
    return {phase:'post',dir:pairDir,impact:pick.Importance,event:pick.Event,until:new Date(pick.ts+win),score:a.score};
  }

  // Jendela pra-rilis: High 15m sebelum rilis, Medium 10m sebelum rilis
  const upcoming=cands.filter(e=>{
    const preWin=(e.Importance>=3?15:10)*60000;
    return e.ts>now&&(e.ts-now)<=preWin;
  });
  if(upcoming.length){
    const u=upcoming[0];
    return {phase:'pre',dir:null,impact:u.Importance,event:u.Event,until:new Date(u.ts)};
  }
  return null;
}

const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));

/* Hitung bias sentimen pasar untuk setiap pair berdasarkan:
   - macro.fng.score (-1 fear .. +1 greed)
   - macro.market24h.riskBias / usdProxyBias
   - liveMetrics: { riskScore, usdScore } opsional dari pergerakan real-time 14 pair */
function pairSentimentBias(pair,macro,liveMetrics){
  const fngScore=macro&&macro.fng&&Number.isFinite(macro.fng.score)?macro.fng.score:0;
  const fngVal=macro&&macro.fng&&Number.isFinite(macro.fng.value)?macro.fng.value:null;
  const fngClass=macro&&macro.fng?macro.fng.classification:'Neutral';
  const m24Risk=macro&&macro.market24h&&Number.isFinite(macro.market24h.riskBias)?macro.market24h.riskBias:0;
  const m24Usd=macro&&macro.market24h&&Number.isFinite(macro.market24h.usdProxyBias)?macro.market24h.usdProxyBias:0;
  const liveRisk=liveMetrics&&Number.isFinite(liveMetrics.riskScore)?liveMetrics.riskScore:null;
  const liveUsd=liveMetrics&&Number.isFinite(liveMetrics.usdScore)?liveMetrics.usdScore:null;

  const riskScore=clamp(liveRisk!=null?(0.55*liveRisk+0.25*m24Risk+0.20*fngScore):(0.55*m24Risk+0.45*fngScore),-1,1);
  const usdScore=clamp(liveUsd!=null?(0.70*liveUsd+0.30*m24Usd):m24Usd,-1,1);

  let pairBias=0;
  if(pair==='BTCUSD'||pair==='ETHUSD'||pair==='NAS100'||pair==='US500'){
    pairBias=riskScore;
  }else if(pair==='XAUUSD'){
    pairBias=clamp(-0.70*usdScore-0.20*Math.min(0,riskScore),-1,1);
  }else if(pair==='EURJPY'||pair==='GBPJPY'){
    pairBias=clamp(0.75*riskScore,-1,1);
  }else if(pair.startsWith('USD')){
    pairBias=clamp(0.85*usdScore+(pair==='USDJPY'?-0.15*Math.min(0,riskScore):0),-1,1);
  }else if(pair.endsWith('USD')){
    const rW=(pair==='AUDUSD'||pair==='NZDUSD')?0.25:0.10;
    pairBias=clamp(-0.85*usdScore+rW*riskScore,-1,1);
  }
  const regime=riskScore>=0.20?'RISK_ON':riskScore<=-0.20?'RISK_OFF':'NEUTRAL';
  return {
    pairBias:Number(pairBias.toFixed(3)),
    riskScore:Number(riskScore.toFixed(3)),
    usdScore:Number(usdScore.toFixed(3)),
    fngValue:fngVal,
    fngClass,
    regime
  };
}

const API={newsCountryCode,parseImpact,newsNum,newsNormalize,newsAffectsPair,newsAnalyze,mapCcyDirToPair,newsBias,pairSentimentBias};
if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.FXContext=API;
})(typeof window!=='undefined'?window:globalThis);
