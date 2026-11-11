/* ============================================================
   FX SNIPER ENGINE v3 — logika murni (tanpa DOM, tanpa Date.now()).
   Dipakai oleh app.js (live) dan backtest.js (offline) -> hasil backtest = perilaku live.
   Horizon sinyal: MENIT (bar 1m, ATR 1m), bukan detik. Informational only.

   v3 kalibrasi (vs v2):
   - Faktor "loc" mean-reversion diganti "brk" (breakout / pullback-continuation).
   - Gate HTF 15m wajib searah; |mom| & |trend| punya lantai magnitudo.
   - Tolak ekstrem berlawanan dalam (brk < -0.55).
   - SL ATR 2.6×, mode balanced terkalibrasi ulang dari walk-forward Binance EURUSDT.

   v4 (anti-SL): SL berbasis swing 10 menit + buffer (bukan ATR 1m saja), tolak entry bila SL swing terlalu jauh,
   filter anti-kejar (spike z60/z180, di puncak range 15m, retrace dari ekstrem 3m), blackout jendela berita,
   konfirmasi lebih lama (persist), BE lebih awal (BE_AT_R), TP1 lebih dekat, jeda setelah 2 loss beruntun.

   v5 (latch): countdown konfirmasi diakumulasi + grace + peluruhan (tidak lagi nol karena satu gate kedip),
   kondisi "plan aktif / cooldown / rugi harian" dipisah dari gate sinyal (kandidat & plan terkunci tetap tampil),
   brkScore dibuat simetris (tidak lagi memihak BUY), spread & lonjakan volatilitas ikut masuk gate grace.

   v6 (kalibrasi jam per pair): PAIRS.hours allowlist UTC dari pair_stats (XAU/BTC 365h, ETH 45h),
   modeFloor per pair, dan inSession/sessionLabel diekspor agar bridge R2 memakai jam yang sama.
   PERINGATAN (lihat log 2-11-2026 di README): angka "XAU PF 1.18→1.72, BTC −0.033→+0.063 PF 1.63"
   adalah hasil IN-SAMPLE — jamnya dipilih di jendela yang sama dengannya dinilai. tools/_hour_oos.js
   menguji ulang dengan jam dipilih hanya di TRAIN: di TEST pemotongan itu MEMBURUK (BTC −0.040→−0.102
   di split 0.6, −0.041→−0,089 di split 0.5; XAU tetap ≈0, ETH tanpa tenaga statistik). Allowlist di
   bawah berstatus TIDAK TERVALIDASI, bukan perbaikan yang terbukti.

   v6.1 (2-11-2026, keputusan operator): PAIRS.hours TIDAK LAGI memblokir. Ia tetap tersimpan sebagai
   prior/label (sessionLabel + out.priorOut), tapi gerbang sesi kembali ke jendela sess[0]..sess[1) dan h24.
   Alasannya bukan "edge-nya hilang" melainkan "edge-nya belum pernah diuji": allowlist itu dipilih in-sample
   dan keluar-sampel justru memburuk, sementara untuk tujuh major FX gerbang ATR/biaya sudah menolak hampir
   semua evaluasi sehingga tidak ada satu trade pun yang mengkalibrasi jam. Jadi jam dibiarkan jadi informasi,
   bukan penentu. Konsekuensi: BTC/ETH (h24) bisa fire di jam berapa pun — yang menahan tetap blackout berita,
   pasar tutup, dan seluruh gerbang mutu.
   ============================================================ */
(function(root){
'use strict';
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
/* Hook berita dinamis: app.js mendaftarkan provider yang mengembalikan
   {phase:'pre'|'post', dir:'UP'|'DOWN'|null, impact, event, until} atau null.
   Engine hanya MEMBACA; tidak fetch. Null = tidak ada konteks berita. */
let _newsProvider=null;
let _sentimentProvider=null;

/* pip, dp, quoteUSD, maxSpread (pips, batas ENTRY), typSpread (pips, biaya asumsi broker retail — EDIT sesuai akun MT5-mu),
   sess = jendela jam UTC [mulai,akhir) fallback ENTRY,
   hours = allowlist jam UTC PRIOR. Sejak v6.1 hanya LABEL/diagnostik (out.priorOut + sessionLabel) —
           tidak lagi memblokir; yang menahan entry tetap sess[0]..sess[1) (h24 untuk crypto).
           STATUS per 2-11-2026 (uji keluar-sampel tools/_hour_oos.js, lihat log README):
           - XAU/BTC/ETH: dipilih in-sample dari tools/_hour_probe.js. Di TEST pemotongan itu tidak mengangkat apa pun
             (BTC justru −0,040→−0,102 R/trade). BUKAN hasil kalibrasi yang terbukti — pertahankan hanya kalau
             memang mau dipakai sebagai pembatas risiko, bukan sebagai sumber edge.
           - FX major: TIDAK ada dasar data sama sekali. tools/_fx_funnel.js: gerbang ATR/biaya menolak 89,8–100,0%
             evaluasi dalam sesi (AUD/CAD nol eval lolos), 35 hari → n=0–4 trade per pair. Isinya prior likuiditas
             (London/NY); setelah typSpread dikalibrasi 3-11-2026 ia tetap tidak memblokir entry.
   calib = override opsional per pair (params + modeFloor). modeFloor = lantai ambang (Math.max dengan mode).
           STATUS per 2-11-2026 (tools/_floor_oos.js, floor diuji dengan hours=null): floor yang menang di TRAIN
           membuat TEST memburuk (XAU −0,010→−0,050 R/trade, 36 trade jadi 17) dan prosedur jujur justru memilih
           nilai lain (XAU lebih ketat, ETH = default balanced, EUR nol kandidat). Dipertahankan atas keputusan
           operator sebagai PENEBAT RISIKO berlabel, bukan sebagai kalibrasi yang terbukti menaikkan PF. */
const PAIRS={
  EURUSD:{name:'EUR/USD',nick:'Fiber',  pip:.0001,dp:5,quoteUSD:true, maxSpread:3.2, typSpread:1.0,sess:[0,24],
    hours:[7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxEURUSD'},
  USDJPY:{name:'USD/JPY',nick:'Gopher', pip:.01,  dp:3,quoteUSD:false,maxSpread:4.5, typSpread:1.2,sess:[0,24],
    hours:[0,1,2,3,7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxUSDJPY'},
  GBPUSD:{name:'GBP/USD',nick:'Cable',  pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.2,sess:[0,24],
    hours:[7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxGBPUSD'},
  USDCHF:{name:'USD/CHF',nick:'Swissie',pip:.0001,dp:5,quoteUSD:false,maxSpread:5.0, typSpread:1.2,sess:[0,24],
    hours:[7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxUSDCHF'},
  AUDUSD:{name:'AUD/USD',nick:'Aussie', pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.2,sess:[0,24],
    hours:[0,1,2,3,7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxAUDUSD'},
  USDCAD:{name:'USD/CAD',nick:'Loonie', pip:.0001,dp:5,quoteUSD:false,maxSpread:5.0, typSpread:1.2,sess:[0,24],
    hours:[12,13,14,15,16,17,18,19], binance:null,deriv:'frxUSDCAD'},
  NZDUSD:{name:'NZ/USD',nick:'Kiwi',   pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.2,sess:[0,24],
    hours:[0,1,2,3,7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxNZDUSD'},
  GBPJPY:{name:'GBP/JPY',nick:'Sterling Yen',pip:.01,dp:3,quoteUSD:false,maxSpread:5.0, typSpread:1.5,sess:[0,24],
    hours:[0,1,2,3,7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxGBPJPY'},
  EURJPY:{name:'EUR/JPY',nick:'Euro Yen',pip:.01,dp:3,quoteUSD:false,maxSpread:4.5, typSpread:1.3,sess:[0,24],
    hours:[0,1,2,3,7,8,9,10,11,12,13,14,15,16], binance:null,deriv:'frxEURJPY'},
  NAS100:{name:'Nasdaq 100',nick:'NASDAQ',kind:'index',pip:1,dp:2,quoteUSD:true,units:1,maxSpread:250,typSpread:3.0,sess:[0,24],
    hours:[13,14,15,16,17,18,19,20], binance:null,deriv:'OTC_NDX'},
  US500:{name:'S&P 500',nick:'SP500',kind:'index',pip:1,dp:2,quoteUSD:true,units:1,maxSpread:80,typSpread:1.0,sess:[0,24],
    hours:[13,14,15,16,17,18,19,20], binance:null,deriv:'OTC_SPC'},
  XAUUSD:{name:'XAU/USD',nick:'Gold',   kind:'metal', pip:.1,   dp:2,quoteUSD:true, units:100,maxSpread:6.0,typSpread:2.5,sess:[0,24],
    hours:[7,8,9,10,11,12,13,14,15,16,17],
    binance:null,deriv:'frxXAUUSD'},
  BTCUSD:{name:'BTC/USD',nick:'Bitcoin',kind:'crypto',h24:true,pip:1,   dp:2,quoteUSD:true, units:1,  maxSpread:60, typSpread:1.0, sess:[0,24],
    hours:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],
    calib:{params:{BAR_MIN:30,SWING_BARS:4,TP1_R:1.3,TP2_R:2.6,PLAN_TTL:240*60000}},
    binance:'btcusdt', deriv:'cryBTCUSD'},
  ETHUSD:{name:'ETH/USD',nick:'Ether',  kind:'crypto',h24:true,pip:.1,  dp:2,quoteUSD:true, units:1,  maxSpread:50, typSpread:1.0, sess:[0,24],
    hours:[0,1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23],
    calib:{params:{BAR_MIN:30,SWING_BARS:4,TP1_R:1.3,TP2_R:2.6,PLAN_TTL:240*60000}},
    binance:'ethusdt', deriv:'cryETHUSD'}
};

const PARAMS={
  ATR_N:14, MIN_BARS:12,
  BAR_MIN:15,                           // bar sinyal 15 menit untuk FX/Gold/Indeks (Crypto override 30m)
  BAR_CAP:1200,                         // simpan 20 jam bar 1 menit agar ATR60 & HTF terisi penuh
  SL_ATR_MULT:1.8, MIN_SL_PIPS:4, COST_SL_MULT:4,   // SL terkalibrasi walk-forward
  SWING_BARS:6, SL_STRUCT_BUF:.4, SL_MAX_ATR:4.5,   // swing struktural 6 bar sinyal + batas validasi
  TP1_R:1.4, TP2_R:2.8, TP1_FRAC:.5,
  COST_EXTRA_PIPS:0,
  BE_AT_R:0,                            // BE hanya setelah TP1 tersentuh (cegah premature stop-out 0R)
  PLAN_TTL:210*60000,                   // Plan aktif 3.5 jam (sesuai bar 15 menit)
  STRICT_SESSION:true,                  // FX/Gold/Indeks mengikuti jam sesi likuid (P.hours)
  MAX_Z60:3.0, MAX_Z180:3.5,
  BRK_CEIL:1.0,                         // Izinkan breakout & trend continuation
  MAX_RETRACE_ATR:1.5,
  LOSS_STREAK_N:3, LOSS_STREAK_PAUSE:45*60000,
  NEWS_BLACKOUT:[],                     // Blackout dinamis berdasarkan kalender nyata
  SPIKE_MAX:3.0,
  MAX_DAILY_LOSS_R:3,
  MIN_MOM:.10, MIN_TREND:.10,
  HTF_SOFT:-.12,
  BRK_FLOOR:-.65,
  SESS_EDGE_MS:3*60000,
  CONFIRM_GRACE:8000,                   // Toleransi konfirmasi 8 detik
  BLEED_DECAY:.6,
  DT_CAP:6000,
  SOFT_HOLD:.85,
  NEAR_ENTER:.85,NEAR_EXIT:.65,
  W:{mom:.25,trend:.45,brk:.15,flow:.10}
};

const MODES={
  agresif:  {minScore:.36,minER:.20,minCost:1.6,persist:5000,cooldown:5*60000},
  balanced: {minScore:.42,minER:.26,minCost:2.0,persist:8000,cooldown:15*60000},
  momentum: {minScore:.40,minER:.24,minCost:1.8,persist:6000,cooldown:12*60000,w:{mom:.38,trend:.37,brk:.15,flow:.10}},
  precision:{minScore:.46,minER:.28,minCost:2.2,persist:12000,cooldown:20*60000},
  liquidity:{minScore:.40,minER:.24,minCost:2.0,persist:8000,cooldown:15*60000,needFlow:true},
  auto:     {minScore:.46,minER:.27,minCost:2.2,persist:10000,cooldown:20*60000},
  edge:     {minScore:.50,minER:.30,minCost:2.5,persist:15000,cooldown:25*60000}
};

function applyModeFloor(mode,cal,modeName){
  if(modeName==='agresif'||!cal||!cal.modeFloor)return mode;
  for(const k of Object.keys(cal.modeFloor)){
    const v=cal.modeFloor[k];if(typeof v==='number'&&typeof mode[k]==='number')mode[k]=Math.max(mode[k],Math.min(v,2.6));
  }
  return mode;
}

/* Bursa FX tutup: akhir pekan (Jumat 22:00 UTC → Minggu 22:00 UTC) plus hari libur bursa
   bertanggal tetap. Yang bergerak (Good Friday, Easter Monday, bank holiday) tidak bisa
   dihitung dari tanggal saja — tambah sendiri ke FX_HOLIDAYS kalau perlu. Crypto (h24)
   tetap jalan 24/7, jadi saat daftar ini aktif universe scan menyusut ke BTC/ETH. */
const FX_HOLIDAYS=new Set(['01-01','12-24','12-25','12-26','12-31']);
const mmdd=d=>String(d.getUTCMonth()+1).padStart(2,'0')+'-'+String(d.getUTCDate()).padStart(2,'0');
const closedFX=t=>{const d=new Date(t);if(FX_HOLIDAYS.has(mmdd(d)))return true;
  const day=d.getUTCDay(),h=d.getUTCHours();return day===6||(day===5&&h>=22)||(day===0&&h<22)};
const isClosed=(pairKey,t)=>{const P=PAIRS[pairKey];return P&&P.h24?false:closedFX(t)};

/* Entry session (v6.1): hanya jendela sess[0]..sess[1) yang memblokir; h24 selalu true (kecuali hard closed).
   Skip SESS_EDGE_MS di menit awal sess[0] supaya noise open tidak ikut. PAIRS.hours TIDAK dipakai lagi di sini
   — lihat outsidePrior(); ia label, bukan gerbang. */
function inSession(pairKey,t,prm){
  const P=PAIRS[pairKey];if(!P)return false;
  if(P.h24)return true;
  if(closedFX(t))return false;
  if(prm&&prm.STRICT_SESSION&&Array.isArray(P.hours)&&P.hours.length){
    return P.hours.includes(new Date(t).getUTCHours());
  }
  return true;
}
/* true bila jam UTC t ada di luar prior jam (hours[]) pair — murni informasi bila STRICT_SESSION=false. */
function outsidePrior(pairKey,t){
  const P=PAIRS[pairKey];
  if(!P||!Array.isArray(P.hours)||!P.hours.length)return false;
  return !P.hours.includes(new Date(t).getUTCHours());
}
function sessionLabel(pairKey){
  const P=PAIRS[pairKey];if(!P)return '';
  if(P.h24)return '24/7 (Crypto)';
  if(pairKey==='NAS100'||pairKey==='US500')return 'US Cash 13–21 UTC';
  if(pairKey==='XAUUSD')return 'London/NY 07–18 UTC';
  if(pairKey==='USDCAD')return 'London/NY 12–20 UTC';
  return P.hours&&P.hours.includes(0)?'Tokyo/London/NY':'London/NY 07–17 UTC';
}

function summarize(list){
  const n=list.length;
  const NULL={n:0,wins:0,winRate:null,avgR:null,totalR:0,pf:null,maxDD:0,mfeAvg:null,maeAvg:null,geoMiss:null,dirMiss:null,
    winLossRatio:null,upsPct:null,winUp:null,winDown:null,holdWin:null,holdLoss:null,sharpe:null,smartSharpe:null};
  if(!n)return NULL;
  let tot=0,gp=0,gl=0,peak=0,dd=0,w=0,mfe=0,mae=0,mfeN=0,geo=0,dir=0;
  const rs=[],up={n:0,w:0},dn={n:0,w:0};let hw=0,hwN=0,hl=0,hlN=0;
  for(const t of list){const r=t.resultR;tot+=r;if(r>0){gp+=r;w++}else gl-=r;peak=Math.max(peak,tot);dd=Math.max(dd,peak-tot);
    // geoMiss = rugi padahal sudah pernah +1R (salah keluar); dirMiss = rugi tanpa pernah +0,5R (salah arah)
    if(typeof t.mfe==='number'&&typeof t.mae==='number'){mfe+=t.mfe;mae+=t.mae;mfeN++;if(r<=0&&t.mfe>=1)geo++;if(r<=0&&t.mfe<.5)dir++}
    rs.push(r);
    if(t.side==='UP'||t.side==='DOWN'){const b=t.side==='UP'?up:dn;b.n++;if(r>0)b.w++}
    /* durasi hold dipakai untuk menguji "potong pemenang lebih cepat dari pemenang" —
       kalau rugi rata-rata ditahan jauh lebih lama, itu bias hold-loser, bukan soal arah. */
    if(t.t&&t.closedAt){const m=(t.closedAt-t.t)/60000;if(m>0){if(r>0){hw+=m;hwN++}else{hl+=m;hlN++}}}}
  const sd=Math.sqrt(rs.reduce((a,x)=>a+(x-tot/n)**2,0)/n);
  /* smart-Sharpe (dipinjam konsepnya dari jesse/services/metrics.py): Sharpe per-trade yang
     pembaginya dihukum bila return antar trade berserial-korelasi. Sharpe tinggi + smart-Sharpe
     rendah = "edge" itu sebenarnya deretan trade yang saling menempel, bukan hasil baru. */
  let rho=0;
  if(n>3&&sd>0){let cov=0,v1=0,v2=0;for(let i=0;i<n-1;i++){cov+=(rs[i]-tot/n)*(rs[i+1]-tot/n);v1+=(rs[i]-tot/n)**2;v2+=(rs[i+1]-tot/n)**2}
    if(v1>0&&v2>0)rho=Math.abs(cov/Math.sqrt(v1*v2))}
  let pen=1;const K=Math.min(n-2,20);for(let k=1;k<=K;k++)pen+=2*((n-k)/n)*rho**k;
  return{n,wins:w,winRate:w/n,avgR:tot/n,totalR:tot,pf:gl>0?gp/gl:(gp>0?Infinity:null),maxDD:dd,
    mfeAvg:mfeN?mfe/mfeN:null,maeAvg:mfeN?mae/mfeN:null,geoMiss:mfeN?geo/mfeN:null,dirMiss:mfeN?dir/mfeN:null,
    winLossRatio:w&&n-w?Math.abs(gp/w/(gl/(n-w))):null,
    upsPct:(up.n+dn.n)?up.n/(up.n+dn.n):null,winUp:up.n?up.w/up.n:null,winDown:dn.n?dn.w/dn.n:null,
    holdWin:hwN?hw/hwN:null,holdLoss:hlN?hl/hlN:null,
    sharpe:sd>0?(tot/n)/sd:null,smartSharpe:(sd>0&&pen>0)?(tot/n)/Math.sqrt(pen)/sd:null};
}

function create(pairKey,opts){
  opts=opts||{};
  const P=PAIRS[pairKey];if(!P)throw new Error('Pair tidak dikenal: '+pairKey);
  const cal=P.calib||{};
  const prm=Object.assign({},PARAMS,cal.params||{},opts.params||{});
  let modeName=opts.mode||'balanced';
  let mode=Object.assign({},MODES[modeName]||MODES.balanced);
  /* modeFloor = lantai per pair (tidak melonggarkan mode ketat seperti edge/auto). */
  applyModeFloor(mode,cal,modeName);
  if(opts.modeOverride)mode=Object.assign(mode,opts.modeOverride);
  const stale=opts.stale||15000, hasFlow=!!opts.hasFlow, feed=opts.feed||'';
  const rd=v=>Number(Number(v).toFixed(P.dp));
  const S1_KEEP=Math.max(1200,prm.BAR_MIN*60*20);  // detik histori harga mentah: harus menutup jendela HTF 15 bar

  const s1=[];      // {t:detik, c:mid} — harga terakhir tiap detik
  const m1=[];      // {k,o,h,l,c} — bar 1 menit dari mid
  const flows=[];   // {ts,f} — order flow bertanda (hanya Binance)
  let bid=0,ask=0,ts=0;
  let trade=null,lastEntry=0,lastLossAt=0,lossStreak=0;
  const closed=[];
  const dayR={day:-1,r:0};
  const cand={side:'',prog:0,bleed:0,prev:0,qualAt:0}; // prog = ms konfirmasi terakumulasi (latch), bleed = lama gate kedip

  /* ---------- data in ---------- */
  function onTick(t,b,a){
    if(!(b>0&&a>0&&a>=b))return[];
    bid=b;ask=a;ts=t;
    const mid=(a+b)/2,sec=Math.floor(t/1000),k=Math.floor(t/60000);
    const L=s1[s1.length-1];
    if(L&&L.t===sec)L.c=mid;else s1.push({t:sec,c:mid});
    const cut=sec-S1_KEEP;while(s1.length&&s1[0].t<cut)s1.shift();
    const M=m1[m1.length-1];
    if(M&&M.k===k){if(mid>M.h)M.h=mid;if(mid<M.l)M.l=mid;M.c=mid}
    else{m1.push({k,o:mid,h:mid,l:mid,c:mid});if(m1.length>prm.BAR_CAP)m1.shift()}
    return manage(t,b,a);
  }
  function addFlow(t,f){flows.push({ts:t,f});while(flows.length&&t-flows[0].ts>60000)flows.shift()}

  /* ---------- helpers ---------- */
  function priceAt(ms){
    const sec=ms/1000;if(!s1.length)return null;
    if(s1[0].t>sec)return s1[0].c;
    let lo=0,hi=s1.length-1;
    while(lo<hi){const m=(lo+hi+1)>>1;if(s1[m].t<=sec)lo=m;else hi=m-1}
    return s1[lo].c;
  }
  /* BAR_MIN: semua faktor dihitung di bar N menit (bukan 1 menit). Alasannya terukur: pada 45 hari data nyata,
     ATR 1m FX/emas hanya 1,5–2× spread tetap → biaya memakan seluruh edge (avgR negatif di SEMUA konfigurasi).
     Bar lebih panjang menaikkan rasio ATR/biaya, bukan dengan menambah filter tapi dengan melebarkan horizon. */
  const barMsOf=()=>prm.BAR_MIN*60000;
  let _agg={n:0,len:0,firstK:0,lastK:0,out:[]};
  function aggregate(bars,n){
    if(n<=1)return bars;
    const len=bars.length;
    if(!len)return[];
    const fk=bars[0].k,lb=bars[len-1],lk=lb.k;
    if(bars===m1&&_agg.n===n&&_agg.len===len&&_agg.firstK===fk&&_agg.lastK===lk&&_agg.out.length){
      const cur=_agg.out[_agg.out.length-1];
      if(lb.h>cur.h)cur.h=lb.h;if(lb.l<cur.l)cur.l=lb.l;cur.c=lb.c;
      return _agg.out;
    }
    const out=[];let cur=null;
    for(const b of bars){const g=Math.floor(b.k/n);
      if(!cur||cur.k!==g){cur={k:g,o:b.o,h:b.h,l:b.l,c:b.c};out.push(cur)}
      else{if(b.h>cur.h)cur.h=b.h;if(b.l<cur.l)cur.l=b.l;cur.c=b.c}}
    if(bars===m1)_agg={n,len,firstK:fk,lastK:lk,out};
    return out;
  }
  /* {bars: yang sudah selesai, live: bar berjalan} pada timeframe sinyal */
  function barsOf(now){
    const agg=aggregate(m1,prm.BAR_MIN);
    const k=Math.floor(now/barMsOf());
    if(agg.length&&agg[agg.length-1].k===k)return{bars:agg.slice(0,agg.length-1),live:agg[agg.length-1]};
    return{bars:agg,live:null};
  }
  function atrOf(bars,n){
    let sum=0,c=0;
    for(let i=Math.max(1,bars.length-n);i<bars.length;i++){
      const b=bars[i],pc=bars[i-1].c;
      sum+=Math.max(b.h-b.l,Math.abs(b.h-pc),Math.abs(b.l-pc));c++;
    }
    return c?sum/c:0;
  }
  const ema=(arr,n)=>{const a=2/(n+1);let e=arr[0];for(let i=1;i<arr.length;i++)e=a*arr[i]+(1-a)*e;return e};
  const inSess=t=>inSession(pairKey,t,prm);
  function newsWindow(t){
    const d=new Date(t),m=d.getUTCHours()*60+d.getUTCMinutes();
    for(const w of prm.NEWS_BLACKOUT)if(m>=w[0]&&m<w[1])return w;
    return null;
  }
  const costPips=()=>{
    const liveSpread=(ask-bid)/P.pip;
    return Math.max(liveSpread>0?liveSpread:P.typSpread, 0.4*P.typSpread)+(prm.COST_EXTRA_PIPS||0);
  };

  /* Skor breakout/pullback SUDAH bersumbu arah (dipanggil dengan brk=d*loc, tanpa dikali d lagi).
     Netral di brk=0, menghargai pullback ringan (−0.35..0) dan breakout dini (0..+), menghukum
     ekstrem berlawanan. Versi lama (0.4+brk… lalu dikali d) memberi bias +0.06 skor ke BUY dan
     −0.06 ke SELL — asimetri itu membuat sinyal DOWN nyaris tidak pernah menembus minScore. */
  function brkScore(brk){
    if(brk<-.55)return Math.max(-1,-.3+(brk+.55)*1.2);        // lawan arah dalam → penalti
    if(brk<0)return Math.max(-.3,.25+brk);                    // pullback ringan → 0..+0.25
    return Math.min(.9,brk*.9);                               // breakout dini → positif, merendah di ekstrem
  }

  /* ---------- trade plan ---------- */
  /* jarak SL: max(ATR, biaya, min pips, swing N-menit + buffer). tooFar = invalidasi terlalu jauh → jangan entry */
  function slInfo(side,atr,entry){
    const buy=side==='UP',base=Math.max(prm.SL_ATR_MULT*atr,prm.COST_SL_MULT*costPips()*P.pip,prm.MIN_SL_PIPS*P.pip);
    const rb=aggregate(m1,prm.BAR_MIN).slice(-prm.SWING_BARS);let sw=0;
    if(rb.length){
      const ext=buy?Math.min(...rb.map(b=>b.l)):Math.max(...rb.map(b=>b.h));
      sw=(buy?entry-ext:ext-entry)+prm.SL_STRUCT_BUF*atr;
    }
    const maxAllowed=(prm.SL_MAX_ATR||5)*atr;
    const rawDist=Math.max(base,sw);
    const dist=rd(rawDist);
    return{dist,tooFar:rawDist>maxAllowed,xAtr:rawDist/atr};
  }
  function buildPlan(side,t,atr){
    if(!(bid>0&&ask>0))return null;
    const buy=side==='UP',d=buy?1:-1,spread=ask-bid,entry=buy?ask:bid;
    const si=slInfo(side,atr,entry),slDist=si.dist;
    const sl=rd(entry-d*slDist);
    const tp1=rd(entry+d*prm.TP1_R*slDist);
    const tp2=rd(entry+d*prm.TP2_R*slDist);
    return{id:pairKey+'|'+t+'|'+side,side,order:buy?'BUY':'SELL',action:buy?'BUY':'SELL',pair:pairKey,entry:rd(entry),
      sl,tp1,tp2,slDist,
      slPips:rd(slDist/P.pip),tp1Pips:rd((prm.TP1_R*slDist)/P.pip),tp2Pips:rd((prm.TP2_R*slDist)/P.pip),
      rr1:prm.TP1_R,rr2:prm.TP2_R,
      atr,atrEst:false,spread,feed,t,expires:t+prm.PLAN_TTL,done:null,tp1hit:false,beArmed:false,beAtR:0,resultR:null,slTooFar:false,
      /* mfe/mae = puncak profit / puncak rugi dalam R, diukur di harga sisi keluar (sudah termasuk spread).
        Bukan hasil — cuma pembeda diagnosis: rugi dengan mfe≥1 itu geometri yang salah, rugi dengan mfe≈0 itu arah yang salah. */
      mfe:0,mae:0};
  }

  /* ---------- manajemen posisi (spread-aware: BUY keluar di bid, SELL keluar di ask) ---------- */
  function manage(t,b,a){
    const tr=trade;if(!tr||tr.done)return[];
    const buy=tr.side==='UP',px=buy?b:a,ev=[];
    const rOf=p=>(buy?p-tr.entry:tr.entry-p)/tr.slDist;
    const rNow=rOf(px);if(rNow>tr.mfe)tr.mfe=rNow;if(rNow<tr.mae)tr.mae=rNow;
    const finish=(why,rg)=>{const r=rg-(prm.COST_EXTRA_PIPS||0)*P.pip/tr.slDist;   // rugi/laba bersih biaya — dayR dan lossStreak harus pakai yang ini, bukan gross
      tr.done=why;tr.resultR=r;tr.closedAt=t;closed.push(tr);trade=null;
      const d=Math.floor(t/86400000);if(dayR.day!==d){dayR.day=d;dayR.r=0}dayR.r+=r;if(r<0)lastLossAt=t;lossStreak=(why==='SL')?lossStreak+1:(r>0?0:lossStreak);
      ev.push({type:'CLOSE',trade:tr})};
    const F=prm.TP1_FRAC;
    if(buy?px<=tr.sl:px>=tr.sl){
      const r=rOf(px);
      const be=tr.tp1hit||tr.beArmed;
      /* BE sebelum TP1 hanya menggeser SL ke entry (tanpa partial close), jadi jika tersentuh SL
         hasil nyatanya adalah r (~0R), bukan tr.beAtR (+0.5R profit fiktif). */
      const beRg=tr.tp1hit?F*prm.TP1_R+(1-F)*r:r;
      finish(be?'BE':'SL',beRg);return ev;
    }
    if(prm.BE_AT_R>0&&!tr.tp1hit&&!tr.beArmed&&rOf(px)>=prm.BE_AT_R){tr.beArmed=true;tr.sl=tr.entry;tr.beAtR=rOf(px);ev.push({type:'BE',trade:tr})}
    if(!tr.tp1hit&&(buy?px>=tr.tp1:px<=tr.tp1)){tr.tp1hit=true;tr.tp1At=t;tr.sl=tr.entry;ev.push({type:'TP1',trade:tr})}
    if(tr.tp1hit&&(buy?px>=tr.tp2:px<=tr.tp2)){finish('TP2',F*prm.TP1_R+(1-F)*rOf(px));return ev}
    if(t>tr.expires){const r=rOf(px);finish('TIME',tr.tp1hit?F*prm.TP1_R+(1-F)*r:r)}
    return ev;
  }

  /* ---------- evaluasi sinyal (v5: LATCH) ----------
     prog = akumulasi ms konfirmasi. Empat kelas kondisi:
       hard    : feed mati / pasar tutup / jendela berita / luar sesi → reset total (konfirmasi lintas kondisi ini tidak sah)
       gate    : skor, ER, ATR÷biaya, mom/trend, htf, z, retrace, SL, spread, volatilitas → boleh kedip; ditahan
                 CONFIRM_GRACE lalu prog meluruh (dulu: satu kedip = timer nol → SETUP hilang, tidak pernah 🔒)
       blocked : plan aktif / cooldown / batas rugi harian → prog DIBEKUKAN dan sinyal tetap qualified
                 (dulu ini dianggap structFail sehingga stage jatuh ke WATCH dan kartu hilang dari board)
       fire    : prog ≥ persist DAN semua gate lolos versi ketat (tanpa pelonggaran) */
  function evaluate(now){
    const out={stage:'WAIT',side:'WAIT',score:0,confidence:0,upProbability:.5,downProbability:.5,potential:0,
      reason:'',fired:false,confirming:false,f:null,alignment:0,alignMax:hasFlow?4:3,price:0,status:'warming',
      prog:0,persistMs:mode.persist,sigOK:false,qualified:false,near:false,blocked:'',hard:''};
    const dt=cand.prev>0?clamp(now-cand.prev,0,prm.DT_CAP):0;
    cand.prev=now;
    const wipe=()=>{cand.side='';cand.prog=0;cand.bleed=0};
    const p=(ask+bid)/2;
    if(!(p>0)||now-ts>stale){wipe();out.reason='Feed stale / belum ada data';return out}
    out.price=p;
    const {bars,live}=barsOf(now);
    const bm=barMsOf();
    if(bars.length<prm.MIN_BARS){wipe();out.reason='Warm-up '+bars.length+'/'+prm.MIN_BARS+' bar '+prm.BAR_MIN+'mnt';return out}
    const p60=priceAt(now-bm),p180=priceAt(now-3*bm),p900=priceAt(now-15*bm);
    if(p60==null||p180==null){wipe();out.reason='Warm-up histori harga';return out}

    const atr=Math.max(atrOf(bars,prm.ATR_N),.3*P.pip),atrP=atr/P.pip;
    const longN=Math.min(60,Math.max(prm.ATR_N+2,bars.length-1));
    const atr60=bars.length>=prm.ATR_N+3?Math.max(atrOf(bars,longN),.3*P.pip):atr,volRatio=atr/atr60;
    const z60=(p-p60)/atr,z180=(p-p180)/(atr*Math.sqrt(3));
    const mom=Math.tanh((.6*z60+.4*z180)/1.2);
    const closes=bars.slice(-40).map(b=>b.c).concat([p]);
    const trend=Math.tanh(((ema(closes,5)-ema(closes,20))/atr)/.8);
    const htf=p900==null?0:Math.tanh(((p-p900)/(atr*Math.sqrt(15)))/1.1);
    const w15=closes.slice(-16);let path=0;for(let i=1;i<w15.length;i++)path+=Math.abs(w15[i]-w15[i-1]);
    const er=path>0?Math.abs(w15[w15.length-1]-w15[0])/path:0;
    const rb=bars.slice(-15),hi=Math.max(p,...rb.map(b=>b.h)),lo=Math.min(p,...rb.map(b=>b.l));
    const loc=hi>lo?clamp((p-(hi+lo)/2)/((hi-lo)/2),-1,1):0;
    let flow=0,flowOK=false;
    if(hasFlow){let bu=0,se=0,c=0;for(const z of flows){if(now-z.ts<=30000){c++;if(z.f>0)bu+=z.f;else se-=z.f}}
      if(c>=5&&bu+se>0){flow=(bu-se)/(bu+se);flowOK=true}}

    /* Arah: bobot HTF+trend lebih besar dari mom 1-bar — mom pendek sering noise yang
       membuat mesin mengejar spike (dirMiss 50–61% di diagnosis). Sisi tetap chase, tapi
       horizonnya lebih lambat; filter BRK_CEIL 0.55 menolak entry di ujung range. */
    const pre=.20*mom+.40*trend+.40*htf;
    const side=pre>=0?'UP':'DOWN',d=pre>=0?1:-1;
    const brk=d*loc, brkN=brkScore(brk);

    const W=Object.assign({},prm.W,mode.w||{});
    const parts=[[W.mom,mom],[W.trend,trend],[W.brk,brkN]];if(flowOK)parts.push([W.flow,flow]);
    const wsum=parts.reduce((a,x)=>a+x[0],0);
    const techScore=parts.reduce((a,x)=>a+x[0]*x[1],0)/wsum;
    const sent=(typeof _sentimentProvider==='function')?_sentimentProvider(pairKey,now):null;
    const sentAdj=sent&&Number.isFinite(sent.pairBias)?clamp(0.06*sent.pairBias,-0.06,0.06):0;
    const score=clamp(techScore+sentAdj,-1,1);

    const spreadPips=(ask-bid)/P.pip,cost=costPips(),costRatio=atrP/cost;
    const aligned=[mom,trend,htf].concat(flowOK?[flow]:[]).filter(v=>Math.sign(v)===d||Math.abs(v)<1e-9).length;
    out.alignMax=hasFlow?4:3;

    const dayLoss=dayR.day===Math.floor(now/86400000)&&dayR.r<=-prm.MAX_DAILY_LOSS_R;
    const cdUntil=Math.max(lastEntry+mode.cooldown,lastLossAt+mode.cooldown*2,lossStreak>=prm.LOSS_STREAK_N?lastLossAt+prm.LOSS_STREAK_PAUSE:0);
    let hard='',hardClosed=false;
    if(isClosed(pairKey,now)){hard='Pasar tutup';hardClosed=true}
    else if(newsWindow(now)){const w=newsWindow(now);hard='Jendela berita '+String(Math.floor(w[0]/60)).padStart(2,'0')+':'+String(w[0]%60).padStart(2,'0')+'–'+String(Math.floor(w[1]/60)).padStart(2,'0')+':'+String(w[1]%60).padStart(2,'0')+' UTC'}
    else if(!inSess(now))hard='Di luar sesi ('+sessionLabel(pairKey)+')';
    const priorOut=outsidePrior(pairKey,now);
    /* Konteks berita dinamis (jika provider terdaftar). */
    const nb=(typeof _newsProvider==='function')?_newsProvider(pairKey,now):null;
    let blocked='';
    if(trade)blocked='Plan aktif '+trade.side+' @ '+trade.entry+' — tunggu selesai';
    else if(nb&&nb.phase==='pre'&&(nb.impact||0)>=2)blocked='Menjelang rilis: '+(nb.event||'news')+' — tunggu rilis & konfirmasi';
    else if(dayLoss)blocked='Batas rugi harian '+prm.MAX_DAILY_LOSS_R+'R tercapai';
    else if(now<cdUntil)blocked='Cooldown '+Math.ceil((cdUntil-now)/60000)+' mnt';
    out.hard=hard;out.blocked=blocked;

    const holding=cand.prog>0&&cand.side===side&&!hard;
    const soft=holding?prm.SOFT_HOLD:1;
    const ge=(v,t)=>({s:v>=t*soft,h:v>=t});
    const le=(v,t)=>({s:v<=t/soft,h:v<=t});
    const bi=v=>({s:v,h:v});
    const z180d=d*z180,z60d=d*z60;
    const rb3=bars.slice(-2).concat(live?[live]:[]),ext3=d>0?Math.max(p,...rb3.map(b=>b.h)):Math.min(p,...rb3.map(b=>b.l));
    const retrace=Math.abs(ext3-p)/atr;
    const si=slInfo(side,atr,d>0?ask:bid);
    const aMom=ge(Math.abs(mom),prm.MIN_MOM),aTrd=ge(Math.abs(trend),prm.MIN_TREND);
    const sentContra=!!(sent&&Number.isFinite(sent.pairBias)&&Math.abs(sent.riskScore||0)>=0.45&&sent.pairBias*d<=-0.45);
    const gates=[
      {g:ge(costRatio,mode.minCost),t:'ATR/biaya '+costRatio.toFixed(1)+'× < '+(mode.minCost*soft).toFixed(1)+'×'},
      {g:ge(er,mode.minER),t:'Pasar choppy (ER '+er.toFixed(2)+' < '+(mode.minER*soft).toFixed(2)+')'},
      {g:ge(Math.abs(score),mode.minScore),t:'Skor '+Math.abs(score).toFixed(2)+' < '+(mode.minScore*soft).toFixed(2)},
      {g:bi(Math.sign(mom)===d&&Math.sign(trend)===d),t:'Momentum & trend tidak searah'},
      {g:{s:aMom.s&&aTrd.s,h:aMom.h&&aTrd.h},t:'Mom/trend terlalu lemah'},
      {g:bi(htf*d>=prm.HTF_SOFT),t:'HTF 15m berlawanan'},
      {g:bi(brk>=prm.BRK_FLOOR),t:'Ekstrem berlawanan (hindari chase)'},
      {g:bi(!mode.needFlow||!flowOK||Math.sign(flow)===d||Math.abs(flow)<.1),t:'Order flow berlawanan'},
      {g:bi(z60d<=prm.MAX_Z60&&z180d<=prm.MAX_Z180),t:'Harga sudah lari (z1m '+z60d.toFixed(1)+', z3m '+z180d.toFixed(1)+') — jangan kejar'},
      {g:le(brk,prm.BRK_CEIL),t:'Di ekstrem range 15m — tunggu pullback'},
      {g:le(retrace,prm.MAX_RETRACE_ATR),t:'Retrace '+retrace.toFixed(1)+'×ATR dari ekstrem 3m — momentum melemah'},
      {g:bi(!si.tooFar),t:'SL swing '+si.xAtr.toFixed(1)+'×ATR > '+prm.SL_MAX_ATR+'× — invalidasi terlalu jauh'},
      {g:le(spreadPips,P.maxSpread),t:'Spread '+spreadPips.toFixed(1)+' pips > maks '+P.maxSpread},
      {g:le(volRatio,prm.SPIKE_MAX),t:'Lonjakan volatilitas ×'+volRatio.toFixed(1)+' (hindari saat berita)'},
      {g:bi(!nb||!nb.dir||nb.dir===side),t:'Berita: '+(nb&&nb.event?nb.event:'news')+' menunjukkan arah berlawanan ('+(nb&&nb.dir?nb.dir:'')+')'},
      {g:bi(!sentContra),t:'Sentimen makro ('+(sent?sent.regime:'')+') berlawanan ekstrem'}
    ];
    const failed=gates.filter(x=>!x.g.s),sigOK=!failed.length,hardOK=gates.every(x=>x.g.h);
    const coreOK=Math.sign(mom)===d&&Math.sign(trend)===d&&brk>=prm.BRK_FLOOR;

    Object.assign(out,{status:'ok',side,score,confidence:Math.abs(score)*100,
      upProbability:(1+score)/2,downProbability:(1-score)/2,potential:costRatio,alignment:aligned,
      near:Math.abs(score)>=mode.minScore*(holding?prm.NEAR_EXIT:prm.NEAR_ENTER),
      r1m:p/p60-1,r3m:p/p180-1,r15m:p900?p/p900-1:0,priorOut,sentiment:sent,
      f:{mom,trend,loc,brk,brkN,htf,flow,flowOK,er,atrP,cost,spreadPips,volRatio,costRatio,session:inSess(now),minCost:mode.minCost,minER:mode.minER,minScore:mode.minScore,
        /* z/retrace/SL ikut dibagikan supaya tools/signal_test.js bisa menilai ulang tiap gerbang
           di luar mesin (ablation). Tanpa ini beberapa gerbang tidak bisa direkonstruksi dari rekaman. */
        z60d,z180d,retrace,slTooFar:si.tooFar,side:d}});

    out.news=nb;out.gatesPassed=gates.length-failed.length;out.gatesTotal=gates.length;
    if(trade&&!trade.done){
      const buy=trade.side==='UP';
      cand.side='';cand.prog=0;cand.bleed=0;
      out.stage='ENTRY';out.side=trade.side;out.order=trade.order||(buy?'BUY':'SELL');
      out.trade=trade;out.fired=false;out.confirming=false;out.qualified=true;
      out.prog=mode.persist;out.locked=true;out.price=p;out.status='ok';
      out.reason=trade.tp1hit?'✅ TP1 tercapai — SL digeser ke entry, sisa target TP2'
        :trade.beArmed?'🟡 BE aktif — SL di entry'
        :'🔒 ORDER VALID TERKUNCI: '+(trade.order||(buy?'BUY':'SELL'))+' @ '+trade.entry.toFixed(P.dp)+
          ' (SL '+trade.sl.toFixed(P.dp)+' · TP1 '+trade.tp1.toFixed(P.dp)+' · TP2 '+trade.tp2.toFixed(P.dp)+')';
      return out;
    }

    /* --- update latch --- */
    if(!cand.side)cand.side=side;
    else if(cand.side!==side){
      if(Math.abs(pre)>=.10||!(cand.prog>0)){cand.side=side;cand.prog=0;cand.bleed=0}
    }
    const sameSide=cand.side===side;
    if(hard){cand.prog=0;cand.bleed=0;cand.side=side}
    else if(sameSide&&sigOK){cand.bleed=0;cand.prog=Math.min(mode.persist,cand.prog+dt)}
    else if(blocked){/* beku: kandidat bertahan, hanya entry yang ditahan */}
    else if(cand.prog>0&&sameSide&&coreOK){
      cand.bleed+=dt;
      if(cand.bleed>prm.CONFIRM_GRACE)cand.prog=Math.max(0,cand.prog-dt*prm.BLEED_DECAY);
    }else if(cand.prog>0&&!sameSide&&Math.abs(pre)<.10){
      cand.bleed+=dt*1.5;
      if(cand.bleed>prm.CONFIRM_GRACE)cand.prog=Math.max(0,cand.prog-dt*prm.BLEED_DECAY*1.5);
    }else{cand.prog=0;cand.bleed=0;cand.side=side}
    out.prog=cand.prog;out.sigOK=sameSide&&sigOK;out.qualified=!hard&&sameSide&&(cand.prog>0||sigOK);

    /* pemicu: cand.prog penuh, arah cocok, dan semua gate ketat (hardOK) lolos */
    if(!hard&&!blocked&&sameSide&&cand.prog>=mode.persist&&hardOK){
      const plan=buildPlan(side,now,atr);
      if(plan){
        trade=plan;lastEntry=now;cand.prog=0;cand.bleed=0;cand.side='';
        out.stage='ENTRY';out.fired=true;out.confirming=false;out.trade=plan;out.locked=true;out.order=plan.order;out.qualified=true;out.prog=mode.persist;
        out.reason=modeName.toUpperCase()+': '+plan.order+' TERKUNCI VALID @ '+plan.entry.toFixed(P.dp)+' (SL '+plan.sl.toFixed(P.dp)+' · TP1 '+plan.tp1.toFixed(P.dp)+')';
        return out;
      }
    }

    if(!hard&&(sigOK||cand.prog>0)){
      out.stage='SETUP';out.confirming=true;
      const pct=Math.round(Math.min(1,cand.prog/mode.persist)*100);
      if(blocked)out.reason='KANDIDAT TERKUNCI '+pct+'% — entry ditahan: '+blocked;
      else if(!sigOK)out.reason='Konfirmasi '+pct+'% (tahan '+Math.max(0,Math.ceil((prm.CONFIRM_GRACE-cand.bleed)/1000))+'s) — goyah: '+failed.map(x=>x.t).join(' • ');
      else out.reason='Konfirmasi '+Math.ceil((mode.persist-cand.prog)/1000)+'s ('+pct+'%) — tunggu sampai TERKUNCI (hijau)';
      return out;
    }

    if(hard){out.stage=hardClosed?'WAIT':'WATCH';out.reason=hard;return out}
    if(failed.length){
      out.stage='WATCH';
      out.reason=(failed.length===1&&Math.abs(score)>=mode.minScore*.7?'Hampir: ':'Disaring: ')+failed.map(x=>x.t).join(' • ');
      return out;
    }
    out.stage='WATCH';out.reason='Menunggu kondisi';return out;
  }

  return{
    onTick,addFlow,evaluate,
    /* Gabungkan bar 1 menit baru dari markets.json ke riwayat yang sudah ada,
       tanpa membuat ulang engine dan tanpa memakai tick dummy. */
    appendBars:bars=>{
      const add=(Array.isArray(bars)?bars:[])
        .filter(b=>b&&[b.k,b.o,b.h,b.l,b.c].every(v=>Number.isFinite(Number(v)))&&Number(b.o)>0&&Number(b.h)>=Number(b.l)&&Number(b.c)>0)
        .map(b=>({k:Number(b.k),o:Number(b.o),h:Number(b.h),l:Number(b.l),c:Number(b.c)}))
        .filter(b=>b.k>(m1.length?m1[m1.length-1].k:-Infinity))
        .sort((a,b)=>a.k-b.k);
      for(const b of add){
        m1.push(b); if(m1.length>prm.BAR_CAP)m1.shift();
        s1.push({t:b.k*60,c:b.o},{t:b.k*60+59,c:b.c});
      }
      const cut=s1.length?s1[s1.length-1].t-S1_KEEP:0; while(s1.length&&s1[0].t<cut)s1.shift();
      return add.length;
    },
    preview:side=>{const bars=barsOf(ts).bars,atr=Math.max(atrOf(bars,prm.ATR_N),.3*P.pip);return bars.length>=2?buildPlan(side,ts,atr):null},
    restoreTrade:tr=>{if(tr&&!tr.done)trade=tr},
    seedBars:bars=>{
      const first=m1.length?m1[0].k:Infinity;
      const add=bars.filter(b=>b.k<first&&b.h>0&&b.l>0).sort((x,y)=>x.k-y.k);
      if(!add.length)return 0;
      m1.unshift(...add);
      const fs=s1.length?s1[0].t:Infinity,pts=[];
      add.forEach(b=>{pts.push({t:b.k*60,c:b.o},{t:b.k*60+59,c:b.c})});
      s1.unshift(...pts.filter(z=>z.t<fs));
      return add.length;
    },
    seed:o=>{if(o.lastEntry)lastEntry=o.lastEntry;if(o.dayR!=null){dayR.day=Math.floor((o.now||ts)/86400000);dayR.r=o.dayR}},
    /* Batalkan rencana yang ternyata tidak pernah jadi posisi (guard menolak). Sengaja TIDAK
       menyentuh lastEntry: cooldown mesin tetap jalan supaya penolakan tidak dikejar terus. */
    abandon:id=>{if(trade&&trade.id===id)trade=null},
    /* Kalau yang menahan hanyalah cooldown penjaga (waktu, bukan penilaian), jangan buang
       kandidatnya: lepaskan rencana, mulai ulang jendela konfirmasi, dan hapus cooldown mesin
       supaya sinyal yang sama bisa diminta kembali dengan harga tick terbaru. */
    rearm:id=>{if(trade&&trade.id===id){trade=null;lastEntry=0;cand.prog=0;cand.bleed=0}},
    setMode:n=>{if(MODES[n]){modeName=n;mode=Object.assign({},MODES[n]);
      applyModeFloor(mode,cal,n);
      if(opts.modeOverride)Object.assign(mode,opts.modeOverride)}},
    modeCfg:()=>mode,params:()=>prm,pair:()=>P,
    get trade(){return trade},get closed(){return closed},get dayR(){return dayR.r}
  };
}

const API={PAIRS,PARAMS,MODES,create,summarize,closedFX,isClosed,inSession,outsidePrior,sessionLabel,H24_KEYS:Object.keys(PAIRS).filter(k=>PAIRS[k].h24),FX_HOLIDAYS:[...FX_HOLIDAYS].sort(),setNewsProvider:fn=>{_newsProvider=fn},setSentimentProvider:fn=>{_sentimentProvider=fn}};
if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.FXEngine=API;
})(typeof window!=='undefined'?window:globalThis);
