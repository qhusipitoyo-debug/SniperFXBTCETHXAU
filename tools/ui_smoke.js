#!/usr/bin/env node
/* Smoke test app.js tanpa browser: DOM + WebSocket + canvas + fetch(stats/pair_stats.json) dipalsukan,
   tick asli dari data/ replay, render() dipanggil manual (setInterval ditangkap). Mengukur apa yang
   dilihat pengguna:
     - error runtime di render/stableSignal/planCardHtml/renderPairStats
     - CHURN: berapa kali sebuah pair muncul lalu hilang dari board
     - PIN: berapa % waktu plan terkunci tetap tampil
     - VONIS: tabel statistik harus memuat semua pair dan memberi label BAGUS/MARGINAL/JELEK
   FX_SNIPER_EMPTY_STATS=1 → stats/pair_stats.json dianggap belum ada (404).
   FX_SNIPER_STALE_DAEMON=1 → ringkasan daemon ada tapi berumur satu jam: panel tidak boleh
   menyebutnya "aktif".
   Pakai: node tools/ui_smoke.js [SYM=EURUSDT] [JAM=12] [MODE=balanced] [FILTER=action|threshold|all] */
const fs=require('fs'),path=require('path');
const SYM=process.argv[2]||'EURUSDT',HOURS=Number(process.argv[3]||12),MODE=process.argv[4]||'balanced',FILTER=process.argv[5]||'action';
/* Argumen ke-6 = geser jam replay dalam hitungan jam. `node tools/ui_smoke.js EURUSDT 12 balanced action 56`
   memindahkan jendela data Jumat ke Sabtu → jalur "bursa tutup, hanya BTC/ETH" ikut diuji. */
const SHIFT=Math.round(Number(process.argv[6]||0)*3600000);
const E=require('../engine.js');
const file=path.join(__dirname,'..','data',SYM+'_1m.csv');
const rows=[];
for(const l of fs.readFileSync(file,'utf8').split('\n')){const c=l.split(',');if(c.length<3)continue;const t=Number(c[0]);if(!t)continue;rows.push([t+SHIFT,Number(c[1]),Number(c[2])])}
const end=rows[rows.length-1][0],start=end-HOURS*3600000,ticks=rows.filter(r=>r[0]>=start);
if(ticks.length<1000){console.log('data kurang');process.exit(1)}

/* ---------- DOM stub ---------- */
const els={};
function mkEl(id){
  const ctx=new Proxy({},{get:(t,k)=>k==='createLinearGradient'?(()=>({addColorStop(){}})):(k in t?t[k]:(...a)=>undefined),set:(t,k,v)=>(t[k]=v,true)});
  return{id,style:{},value:'',textContent:'',innerHTML:'',dataset:{},width:0,height:0,
    classList:{add(){},remove(){},toggle(){},contains(){return false}},
    getContext:()=>ctx,getBoundingClientRect:()=>({width:640,height:150}),
    querySelector:()=>null,querySelectorAll:()=>[],closest:()=>null,getAttribute:()=>null,
    appendChild(){},remove(){},click(){},focus(){}};
}
const document={getElementById:id=>els[id]||(els[id]=mkEl(id)),addEventListener(){},createElement:()=>mkEl('tmp'),body:{appendChild(){}},title:''};
const location={search:'?feed=deriv&mode='+MODE+'&filter='+FILTER};
const store={};
const localStorage={getItem:k=>(k in store?store[k]:null),setItem:(k,v)=>{store[k]=String(v)},removeItem:k=>{delete store[k]}};
const navigator={clipboard:{writeText:async()=>{}}};
const alerts=[];const confirm=()=>true,alert=m=>alerts.push(m);

/* ---------- fetch stub: stats/pair_stats.json (satu-satunya fetch app.js sekarang) ----------
   Bentuknya sama seperti keluaran tools/pair_stats.js. Angkanya dipilih supaya setiap vonis
   muncul minimal sekali: BAGUS, MARGINAL, JELEK, sampel kecil, dan tanpa data. */
const fetchCalls=[];
const MODES_ALL=Object.keys(E.MODES);
/* Pecahan per jam: {n,w,g,l} — panel menurunkan avgR=(g-l)/n dan PF=g/l sendiri, jadi
   keempat cabang vonis per jam (BAGUS/MARGINAL/JELEK/tipis) bisa diuji tanpa menyentuh data. */
const HOUR_STUB={
  bagus:{3:{n:40,w:24,g:48,l:20}},                       /* avgR +0,70 PF 2,40 → BAGUS */
  marginal:{9:{n:30,w:16,g:20,l:19}},                    /* avgR +0,03 PF 1,05 → MARGINAL */
  jelek:{15:{n:35,w:10,g:10,l:25}},                      /* avgR −0,43 PF 0,40 → JELEK */
  tipis:{21:{n:8,w:4,g:5,l:5}}                           /* n < 20 → tipis, apa pun angkanya */
};
function st(n,wins,avgR,pf,dd,oc,hours){
  return {n,wins,winRate:n?wins/n:null,avgR,totalR:avgR*n,pf,maxDD:dd,winLossRatio:null,
    mfeAvg:.3,maeAvg:-.3,geoMiss:.1,dirMiss:.4,upsPct:.5,winUp:.5,winDown:.5,
    holdWin:38,holdLoss:21,sharpe:.1,smartSharpe:.08,outcome:oc,hours:hours||{}};
}
const PAIR_STATS={generatedAt:Date.now()-3600000,
  engine:{TP1_R:1,TP2_R:2.2,TP1_FRAC:.5,SL_ATR_MULT:3.2,BE_AT_R:.4,PLAN_TTL:3600000,COST_EXTRA_PIPS:0},
  evalMs:1000,modes:MODES_ALL,note:'stub ui_smoke',
  pairs:{
    BTCUSD:{name:'BTC/USD',symbol:'BTCUSDT',file:'BTCUSDT_1m.csv',rows:1000,window:{from:0,to:1,days:45},
      modes:Object.fromEntries(MODES_ALL.map(m=>[m,Object.assign(st(393,163,-.033,.79,14.6,{TIME:356,BE:23,SL:13,TP2:1}),{hours:Object.assign({},HOUR_STUB.bagus,HOUR_STUB.tipis)})]))},
    XAUUSD:{name:'XAU/USD',symbol:'PAXGUSDT',file:'PAXGUSDT_1m.csv',rows:1000,window:{from:0,to:1,days:45},
      modes:Object.fromEntries(MODES_ALL.map(m=>[m,st(124,58,.026,1.18,6.9,{TIME:114,BE:7,TP2:2,SL:1},HOUR_STUB.marginal)]))},
    ETHUSD:{name:'ETH/USD',symbol:'ETHUSDT',file:'ETHUSDT_1m.csv',rows:1000,window:{from:0,to:1,days:45},
      modes:Object.fromEntries(MODES_ALL.map(m=>[m,st(39,16,-.011,.91,4.1,{TIME:34,SL:3,TP2:2},HOUR_STUB.jelek)]))},
    /* n=1: EURUSD benar-benar hanya menghasilkan satu plan dalam 45 hari pada mode balanced.
       Panel wajib bilang sampel kurang, bukan 0% winrate yang terbaca sebagai "jelek". */
    EURUSD:{name:'EUR/USD',symbol:'EURUSDT',file:'EURUSDT_1m.csv',rows:1000,window:{from:0,to:1,days:45},
      modes:Object.fromEntries(MODES_ALL.map(m=>[m,st(1,0,-.042,0,.04,{TIME:1})]))},
    /* Catatan MARGINAL: avgR positif tapi PF di bawah 1,1 — satu-satunya jalur vonis yang tidak
       tercapai oleh angka nyata di atas, jadi dipalsukan supaya cabang kodenya ikut teruji. */
    USDJPY:{name:'USD/JPY',symbol:'USDJPY_M',file:'USDJPY_M_1m.csv',rows:1000,window:{from:0,to:1,days:45},
      modes:Object.fromEntries(MODES_ALL.map(m=>[m,st(45,22,.021,1.05,3.3,{TIME:38,BE:4,SL:2,TP2:1})]))}
  },
  missing:Object.keys(E.PAIRS).filter(k=>!['BTCUSD','XAUUSD','ETHUSD','EURUSD','USDJPY'].includes(k))
    .map(k=>({pair:k,name:E.PAIRS[k].name,reason:'tidak ada sumber data lokal untuk pair ini'}))};
/* Berkas keluaran tools/collector.js — ledger JSONL (baris mentah per plan) dan ringkasannya.
   Tiga plan ini cukup untuk menguji: filter mode, sumber gabungan, dan baris status daemon. */
const DAEMON_LEDGER=[
  {id:'EURUSD|1|UP',pair:'EURUSD',mode:'balanced',t:Date.now()-3600000,closedAt:Date.now(),side:'UP',done:'TP2',resultR:1.9,mfe:2.1,mae:-.2},
  {id:'EURUSD|2|DOWN',pair:'EURUSD',mode:'balanced',t:Date.now()-7200000,closedAt:Date.now(),side:'DOWN',done:'SL',resultR:-1,mfe:.1,mae:-1},
  {id:'XAUUSD|3|UP',pair:'XAUUSD',mode:'momentum',t:Date.now()-3600000,closedAt:Date.now(),side:'UP',done:'TIME',resultR:.3,mfe:.4,mae:-.1}
];
const DAEMON_STATS={kind:'live',generatedAt:Date.now(),startedAt:Date.now()-3*3600000,uptimeMin:180.4,
  feed:'deriv',modes:['balanced','momentum'],pairsTested:2,
  counters:{ticks:12345,closed:3,reconnects:0,errors:0,lastTickAgeS:2.4},pairs:{},total:{}};
/* FX_SNIPER_EMPTY_STATS=1 → ketiga berkas belum dibuat (clone baru, daemon belum pernah jalan).
   Panel harus tetap menampilkan SEMUA pair yang dipindai beserta alasannya, bukan blok yang hilang.
   FX_SNIPER_STALE_DAEMON=1 → ringkasan berumur 1 jam: berkasnya ADA tapi collector-nya sudah
   mati, dan panel tidak boleh menyebutnya "aktif". generatedAt diukur dari jam panel (simNow),
   bukan jam dinding, supaya perbandingan umurnya tidak bergantung pada kapan tesnya jalan. */
const STALE=!!process.env.FX_SNIPER_STALE_DAEMON;
/* generatedAt dibaca lewat getter, bukan nilai tetap: jam harness (simNow) maju belasan jam
   selama replay, jadi tangkai waktu statis akan membuat panel menganggap daemon mati di
   pemeriksaan terakhir — padahal yang berubah adalah jam tesnya, bukan isi berkas. */
function statsNow(){
  const o=Object.assign({},DAEMON_STATS);
  Object.defineProperty(o,'generatedAt',{get:()=>simNow-(STALE?3600000:60000)});
  return o;
}
function fetch(url,init){
  const u=String(url);
  fetchCalls.push({url:u,method:(init&&init.method)||'GET'});
  const empty=!!process.env.FX_SNIPER_EMPTY_STATS;
  if(empty)return Promise.resolve({ok:false,status:404,json:()=>Promise.reject(new Error('HTTP 404')),text:()=>Promise.resolve('Not Found')});
  if(u.indexOf('live_ledger.jsonl')>=0){
    const body=DAEMON_LEDGER.map(r=>JSON.stringify(r)).join('\n')+'\n';
    return Promise.resolve({ok:true,status:200,text:()=>Promise.resolve(body),json:()=>Promise.reject(new Error('bukan JSON'))});
  }
  if(u.indexOf('live_stats.json')>=0)
    return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(statsNow()),text:()=>Promise.resolve(JSON.stringify(statsNow()))});
  return Promise.resolve({ok:true,status:200,json:()=>Promise.resolve(PAIR_STATS),text:()=>Promise.resolve(JSON.stringify(PAIR_STATS))});
}

/* ---------- WebSocket stub (laju Deriv) ---------- */
const sockets=[];
class WebSocket{
  constructor(url){this.url=url;this.readyState=1;this.sent=[];sockets.push(this);
    setTimeout(()=>{try{this.onopen&&this.onopen()}catch(e){console.error('ws onopen',e)}},0);}
  send(raw){this.sent.push(raw);
    try{const m=JSON.parse(raw);
      if(m.ticks_history){const sym=m.ticks_history;const p=PAIR_OF[sym];
        if(p){const c=candlesBefore(p,simNow);this.onmessage({data:JSON.stringify({candles:c,echo_req:m})})}}
      if(m.ticks)(this.subs||(this.subs=new Set())).add(m.ticks)
    }catch(e){console.error('ws send',e)}}
  close(){this.readyState=3}
}
WebSocket.OPEN=1;
const PAIR_OF={},SYM_OF={};
for(const k of Object.keys(E.PAIRS)){PAIR_OF[E.PAIRS[k].deriv]=k;SYM_OF[k]=E.PAIRS[k].deriv}
function candlesBefore(pair,ms){
  const need=45,out=[];const pip=E.PAIRS[pair].pip;
  let i=0;
  for(const [t,b,a] of ticks){if(t>=ms-need*60000&&t<ms){out.push({epoch:Math.floor(t/1000),open:b,high:Math.max(b,a),low:Math.min(b,a),close:a});if(out.length>need*8)break}}
  const agg={};
  out.forEach(c=>{const k=Math.floor(c.epoch/60)*60;(agg[k]=agg[k]||{epoch:k,open:c.open,high:c.high,low:c.low,close:c.close});
    agg[k].high=Math.max(agg[k].high,c.high);agg[k].low=Math.min(agg[k].low,c.low);agg[k].close=c.close});
  return Object.values(agg).slice(-need);
}

/* ---------- clock + timer capture ---------- */
let simNow=ticks[0][0];const realNow=Date.now;
Date.now=()=>simNow;
const captured={intervals:[],timeouts:[]};
const _setInterval=setInterval,_setTimeout=setTimeout;
global.setInterval=(fn,ms)=>{captured.intervals.push({fn,ms});return captured.intervals.length-1};
global.clearInterval=id=>{if(captured.intervals[id])captured.intervals[id]=null};
global.setTimeout=(fn,ms)=>{captured.timeouts.push(fn);return 0};

/* ---------- muat app.js ---------- */
const errors=[];
const _err=console.error;console.error=(...a)=>{errors.push(a.map(x=>String(x&&x.stack||x)).join(' '));_err(...a)};
global.document=document;global.location=location;global.localStorage=localStorage;global.navigator=navigator;
global.WebSocket=WebSocket;global.alert=alert;global.confirm=confirm;global.window=global;global.FXEngine=E;
global.fetch=fetch;
require('../app.js');

/* ---------- replay (jalan setelah boot IIFE app.js selesai — microtask di-flush dulu) ---------- */
const ONLYSYM=E.PAIRS[Object.keys(E.PAIRS).find(k=>(E.PAIRS[k].binance||'')===SYM.toLowerCase())||'EURUSD'].deriv;
const present={},churn={appear:0,drop:0},pin={ok:0,total:0},seenHist={};
let idx=0,stepMs=500,processed=0,planFrames=0;
function replay(renderCb){
for(let t=simNow;t<ticks[ticks.length-1][0];t+=stepMs){
  simNow=t;
  while(idx<ticks.length&&ticks[idx][0]<=t){
    const [ts,b,a]=ticks[idx++],ws=sockets[0];
    if(ws&&ws.onmessage)ws.onmessage({data:JSON.stringify({tick:{symbol:ONLYSYM,epoch:Math.floor(ts/1000),bid:b,ask:a}})});
    processed++;
  }
  captured.timeouts.splice(0).forEach(fn=>{try{fn()}catch(e){errors.push('timeout throw: '+(e&&e.stack||e))}});
  try{renderCb()}catch(e){errors.push('render throw: '+(e&&e.stack||e))}
  const html=els.alertBoard?els.alertBoard.innerHTML:'';
  const seen=new Set();
  for(const k of Object.keys(E.PAIRS))if(html.includes('data-pair="'+k+'"'))seen.add(k);
  seen.forEach(k=>{if(!present[k]){present[k]=true;churn.appear++}});
  Object.keys(present).forEach(k=>{if(present[k]&&!seen.has(k)){present[k]=false;churn.drop++}});
  if(/alertCard[^"]*entry/.test(html)){planFrames++;pin.total++;if(/pinned/.test(html))pin.ok++}
  seenHist[t]=seen.size;
}
report();
}
function report(){Date.now=realNow;console.error=_err;
const hours=Number(HOURS).toFixed(1);
console.log('\n=== ui_smoke '+SYM+' ('+ONLYSYM+') • '+hours+' jam • mode '+MODE+' • filter '+FILTER+(SHIFT?' • jam digeser +'+(SHIFT/3600000)+'h → '+new Date(ticks[0][0]).toUTCString():'')+' ===');
console.log('  tick dikirim       : '+processed);
console.log('  error runtime      : '+errors.length+(errors.length?'\n     '+errors.slice(0,3).join('\n     '):' (bersih)'));
const dicetak=errors.length;   // pemeriksaan isi panel menambah errors SESUDAH baris ini dicetak
console.log('  kartu tampil       : '+churn.appear+' kemunculan, '+churn.drop+' hilang → hilang/muncul '+(churn.appear?(churn.drop/churn.appear).toFixed(2):'—'));
console.log('  churn board/jam    : '+((churn.appear+churn.drop)/Number(hours)).toFixed(1)+' perubahan baris');
console.log('  frame berisi ENTRY : '+planFrames+'; kartu 🔒 terpaku '+(planFrames?(100*pin.ok/Math.max(1,pin.total)).toFixed(0)+'%':'—'));
console.log('  isi board terakhir : '+(els.alertBoard?String(els.alertBoard.innerHTML).slice(0,200).replace(/</g,'〈'):'—'));
console.log('  scan board         : '+(els.scanBoard?String(els.scanBoard.innerHTML).slice(0,160).replace(/</g,'〈'):'—'));
/* ---- PANEL STATISTIK PER PASANGAN ----
   Yang diuji di sini adalah hal yang paling mahal kalau salah: vonis BAGUS/JELEK.
   Aturan yang diuji, bukan angkanya — angka aslinya dicek oleh tools/pair_stats.js.
     1. SETIAP pair yang dipindai harus punya baris, termasuk yang tidak ada datanya
        (pair yang belum diuji tidak boleh hilang diam-diam dari tabel).
     2. Tiap level vonis harus muncul sesuai ambangnya, dan SAMPEL KECIL tidak boleh
        dibaca sebagai JELEK. */
const EMPTY=!!process.env.FX_SNIPER_EMPTY_STATS;
const P=els.pairStatsBoard?String(els.pairStatsBoard.innerHTML):'';
const V=els.pairStatsVerdict?String(els.pairStatsVerdict.innerHTML):'';
const SRC=els.pairStatsSrc?String(els.pairStatsSrc.innerHTML):'';
const rows=(P.match(/class="pairRow/g)||[]).length;
const tag=k=>(P.match(new RegExp('vTag '+k+'">','g'))||[]).length;
console.log('  statistik per pair : '+fetchCalls.length+' fetch, '+rows+' baris • BAGUS '+tag('good')+' MARGINAL '+tag('marginal')+' JELEK '+tag('bad')+' TANPA DATA/SAMPEL '+tag('none'));
console.log('  sumber             : '+SRC.slice(0,150).replace(/</g,'〈'));
if(rows!==Object.keys(E.PAIRS).length)errors.push('tabel statistik tidak memuat semua pair yang dipindai: '+rows+'/'+Object.keys(E.PAIRS).length);
if(!EMPTY&&SRC.indexOf('pair_stats.json belum ada')>=0)errors.push('fetch gagal tanpa FX_SNIPER_EMPTY_STATS: '+SRC.slice(0,90));
if(!EMPTY&&V.indexOf('Ambang vonis')<0)errors.push('vonis tanpa baris ambang — angka akan dibaca tanpa konteks');
if(!EMPTY){
  if(tag('good')!==1)errors.push('harus tepat 1 baris BAGUS (XAUUSD avgR>0 PF 1.18), dapat '+tag('good'));
  if(tag('marginal')!==1)errors.push('harus tepat 1 baris MARGINAL (USDJPY avgR>0 PF 1.05), dapat '+tag('marginal'));
  if(tag('bad')!==2)errors.push('harus tepat 2 baris JELEK (BTCUSD + ETHUSD avgR<0 PF<1), dapat '+tag('bad'));
  if(P.indexOf('SAMPEL 1/30')<0)errors.push('EURUSD n=1 harus jadi SAMPEL KECIL, bukan 0% yang terbaca jelek');
  if(P.indexOf('TANPA DATA')<0)errors.push('pair tanpa file data tidak ditandai TANPA DATA');
  if(P.indexOf('41.5%')<0)errors.push('winrate BTCUSD 41.5% tidak muncul di tabel');
  if(V.indexOf('JELEK</b> (2)')<0)errors.push('ringkasan vonis tidak menghitung 2 pair JELEK: '+V.slice(0,160).replace(/</g,'〈'));
}else{
  console.log('  mode tanpa berkas  : '+rows+' baris pair, vonis "'+(P.match(/vTag none">([^<]*)/)||[,'—'])[1]+'"');
  if(SRC.indexOf('pair_stats.json belum ada')<0)errors.push('tanpa stats/pair_stats.json panel tidak memberi cara membuatnya');
}
/* Papan per jam: 24 sel harus SELALU ada dua puluh empat — jam tanpa trade berbeda dari
   jam yang belum dihitung, dan keduanya berbeda dari jam yang jelek. */
const HB=els.hourBoard?String(els.hourBoard.innerHTML):'';
const HN=els.hourNote?String(els.hourNote.innerHTML):'';
const hcell=k=>(HB.match(new RegExp('hourCell '+k+'"','g'))||[]).length;
const htot=(HB.match(/class="hourCell /g)||[]).length;
console.log('  per jam UTC        : '+htot+' sel • BAGUS '+hcell('good')+' MARGINAL '+hcell('marginal')+' JELEK '+hcell('bad')+' tipis '+hcell('thin')+' kosong '+hcell('none'));
if(htot!==24)errors.push('papan per jam harus 24 sel, dapat '+htot);
if(!EMPTY){
  /* Dites per sel, bukan lewat jumlah: ledger live tab ini menambah trade ke jam yang mana saja,
     jadi "tepat N sel berlabel X" akan gagal/lolos tergantung jam berapanya sekarang. */
  const at=h=>{const m=HB.match(new RegExp('class="hourCell ([a-z]+)"><b>'+String(h).padStart(2,'0')+':00'));return m?m[1]:'(tidak ada sel)'};
  console.log('  vonis per sel      : 03:00='+at(3)+' 09:00='+at(9)+' 15:00='+at(15)+' 21:00='+at(21));
  if(at(3)!=='good')errors.push('jam 03:00 (n=40, avgR +0,7, PF 2,4) harus BAGUS, dapat '+at(3));
  if(at(9)!=='marginal')errors.push('jam 09:00 (avgR>0 tapi PF 1,05) harus MARGINAL, dapat '+at(9));
  if(at(15)!=='bad')errors.push('jam 15:00 (avgR<0, PF 0,4) harus JELEK, dapat '+at(15));
  if(at(21)!=='thin')errors.push('jam 21:00 (n=8 < 20) harus "tipis", bukan dinilai, dapat '+at(21));
  if(HN.indexOf('Terbaik')<0||HN.indexOf('03:00')<0)errors.push('catatan per jam tidak menyebut jam terbaik: '+HN.slice(0,120).replace(/</g,'〈'));
  if(HN.indexOf('avgR dan PF kasar')<0)errors.push('catatan per jam tidak membatasi apa yang dinilai — maxDD per jam tidak ada artinya');
}else{
  /* Tanpa berkas replay, sampel yang ada hanyalah ledger tab ini — beberapa plan saja, jadi
     yang harus dijamin adalah TIDAK ADA jam yang dinilai. Sel mana yang terisi bergantung pada
     jam berapa plan tab itu selesai, jadi jumlah sel "none" tidak bisa dijadikan assertion. */
  if(hcell('good')+hcell('marginal')+hcell('bad')>0)
    errors.push('jam dinilai dari sampel tab saja (<20 trade) — seharusnya semuanya "tipis" atau kosong');
  if(HN.indexOf('Belum ada satu jam pun')<0)errors.push('papan kosong tanpa penjelasan ambang sampel');
}
/* Daemon 24/7: panel membaca LEDGER (baris mentah), bukan ringkasannya, dan menyaring
   berdasar mode — jadi mode balanced hanya boleh melihat 2 plan EURUSD, bukan yang momentum. */
const LB=els.livePairBoard?String(els.livePairBoard.innerHTML):'';
const LS=els.livePairSrc?String(els.livePairSrc.textContent||els.livePairSrc.innerHTML):'';
console.log('  daemon 24/7        : '+(LS.slice(0,96)||'(kosong)')+(STALE?' [ringkasan berumur 1 jam]':''));
if(!EMPTY){
  if(LS.indexOf('dari daemon 24/7')<0)errors.push('sumber catatan live tidak menyebut daemon: '+LS.slice(0,90));
  if(STALE){
    /* Berkas ada tapi sudah sejam tidak ditulis ulang = collector mati. Panel tidak boleh
       memajang "daemon aktif 3.0 jam" untuk angka yang berhenti bertambah. */
    if(LS.indexOf('daemon aktif')>=0)errors.push('ringkasan berumur satu jam masih disebut aktif: '+LS.slice(0,90));
    if(LS.indexOf('collector.js tidak berjalan')<0)errors.push('collector yang mati tidak dilaporkan di baris sumber: '+LS.slice(0,90));
  }else{
    if(LS.indexOf('3.0 jam')<0)errors.push('umur daemon tidak dibaca dari live_stats.json: '+LS.slice(0,90));
  }
  if(LB.indexOf('ETH/USD')>=0)errors.push('plan momentum tidak boleh masuk saat mode balanced (baris XAUUSD tersaring)');
  if(!/EUR\/USD/.test(LB))errors.push('ledger daemon tidak muncul di CATATAN LIVE');
}else{
  if(LS.indexOf('daemon')>=0)errors.push('tanpa berkas daemon tidak boleh ada klaim daemon di baris sumber: '+LS.slice(0,90));
  /* papan kosong = belum ada plan sama sekali → wajib menyebut cara menyalakan collector.
     Kalau ledger tab ini sudah punya plan, papan memang berisi baris, bukan pesan kosong. */
  if(LB.indexOf('historyEmpty')>=0&&LB.indexOf('collector.js')<0)
    errors.push('CATATAN LIVE kosong tanpa cara menyalakan collector.js');
}
if(errors.length>dicetak)console.log('\n  ✘ pemeriksaan isi panel gagal ('+(errors.length-dicetak)+'):\n     '+errors.slice(dicetak).join('\n     '));
process.exitCode=errors.length?1:0;}
(async()=>{
  for(let i=0;i<30;i++)await Promise.resolve();
  const ri=captured.intervals.find(i=>i&&i.ms===500);
  if(!ri){console.log('✘ render() tidak terjaring — setInterval(…,500) tidak terdaftar');process.exit(1)}
  replay(ri.fn);
})();
