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
  /* typSpread = biaya ASUMSI broker ritel yang dipakai gerbang ATR/biaya, BUKAN spread hasil rekaman.
     Sejak 3-11-2026 angka ini DIPASANG dari pengukuran terminal hidup (tools/_spread_measure.js --akun=180,
     181 baris status, akun FBS-Real): tujuh major 0,90–1,20 pips, emas 2,50, BTC 19,65, ETH 19,30.
     Nilai di bawah = batas atas pengukuran + margin kecil (major 1,2–1,5; emas 3,0; crypto 20) supaya
     lonjakan spread sesaat tidak langsung membunuh sinyal. Ini BUKAN janji spread broker lain: EDIT
     angka ini sesuai akunmu (akun raw/commission → isi juga PARAMS.COST_EXTRA_PIPS).
     Catatan replay: data/*_1m.csv yang sudah ada menuliskan spread = typSpread LAMA, jadi backtest lama
     tetap konservatif karena costPips() memakai Math.max(spread data, typSpread baru). Kalau CSV dibuat
     ulang dengan tools/fetch_deriv.js, spread ikut angka baru — benar untuk akun dengan spread baru,
     tapi bukan pembanding apple-to-apple dengan hasil lama. */
  EURUSD:{name:'EUR/USD',nick:'Fiber',  pip:.0001,dp:5,quoteUSD:true, maxSpread:3.2, typSpread:1.2,sess:[7,16],
    hours:[7,8,9,10,11,12,13,14,15], calib:{modeFloor:{minCost:4.0}}, binance:'eurusdt',deriv:'frxEURUSD'},
  USDJPY:{name:'USD/JPY',nick:'Gopher', pip:.01,  dp:3,quoteUSD:false,maxSpread:4.5, typSpread:1.5,sess:[0,16],
    hours:[0,1,2,3,7,8,9,12,13,14,15], binance:null,deriv:'frxUSDJPY'},
  GBPUSD:{name:'GBP/USD',nick:'Cable',  pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.5,sess:[7,16],
    hours:[7,8,9,10,11,12,13,14,15], binance:null,deriv:'frxGBPUSD'},
  USDCHF:{name:'USD/CHF',nick:'Swissie',pip:.0001,dp:5,quoteUSD:false,maxSpread:5.0, typSpread:1.5,sess:[7,16],
    hours:[7,8,9,12,13,14,15], binance:null,deriv:'frxUSDCHF'},
  AUDUSD:{name:'AUD/USD',nick:'Aussie', pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.5,sess:[0,16],
    hours:[0,1,2,3,7,8,9,12,13,14,15], binance:null,deriv:'frxAUDUSD'},
  USDCAD:{name:'USD/CAD',nick:'Loonie', pip:.0001,dp:5,quoteUSD:false,maxSpread:5.0, typSpread:1.5,sess:[12,20],
    hours:[12,13,14,15,16,17,18,19], binance:null,deriv:'frxUSDCAD'},
  NZDUSD:{name:'NZD/USD',nick:'Kiwi',   pip:.0001,dp:5,quoteUSD:true, maxSpread:5.0, typSpread:1.5,sess:[0,16],
    hours:[0,1,2,3,7,8,9,12,13,14,15], binance:null,deriv:'frxNZDUSD'},
  /* --- Emas & crypto. pip: XAU 0.1, BTC 1, ETH 0.1. units = kontrak/lot di FBS (cek spesifikasi).
     typSpread BTC/ETH mengikuti poin broker (≈19–20 pip). h24 = tidak kena weekend FX.
     TIGA baris di bawah adalah angka IN-SAMPLE (jam dipilih di jendela yang sama), lihat catatan `hours`
     di atas dan tools/_hour_oos.js:
       hours XAU: potong jam 9,14,16–19 → PF 1,18→1,72 in-sample; TEST ≈ 0 di dua split (n=28–32 saja).
       hours BTC: 8,9,19,23 (14 dibuang) → avgR −0,033→+0,063 in-sample; jam yang sama dipilih TANPA TEST
                  justru memberi avgR −0,102 di TEST. Baris "shipped" yang bagus di TEST = kebocoran.
       ETH 45h: tidak ada jam dengan n≥6 → tidak ada dasar; modeFloor juga in-sample dan memperkecil n.
     EUR major: edge arah belum ada di data (signal_test: −0,022 ATR p=0,184; n=0 trade di sumber Deriv). */
  XAUUSD:{name:'XAU/USD',nick:'Gold',   kind:'metal', pip:.1,   dp:2,quoteUSD:true, units:100,maxSpread:8,  typSpread:3.0,sess:[7,16],
    hours:[7,8,10,11,13,15], calib:{modeFloor:{minScore:.50,minER:.33,minCost:3.8}},
    binance:'paxgusdt',deriv:'frxXAUUSD'},
  BTCUSD:{name:'BTC/USD',nick:'Bitcoin',kind:'crypto',h24:true,pip:1,   dp:2,quoteUSD:true, units:1,  maxSpread:60, typSpread:20, sess:[0,24],
    hours:[8,9,19,23],
    binance:'btcusdt', deriv:'cryBTCUSD'},
  ETHUSD:{name:'ETH/USD',nick:'Ether',  kind:'crypto',h24:true,pip:.1,  dp:2,quoteUSD:true, units:1,  maxSpread:50, typSpread:20, sess:[0,24],
    hours:[0,2,4,10,11,12,17,19], calib:{modeFloor:{minScore:.52,minER:.34,minCost:4.0}},
    binance:'ethusdt', deriv:'cryETHUSD'}
};

const PARAMS={
  ATR_N:14, MIN_BARS:15,
  BAR_MIN:15,                           // timeframe bar sinyal (1/3/5/15 menit). Kalibrasi 45 hari: 1m −0.148R, 5m −0.138R, 15m −0.009R TRAIN / −0.067R TEST — semua negatif, 15m hanya "paling sedikit rugi"
  BAR_CAP:600,                          // simpan berapa bar 1 menit (cukup untuk MIN_BARS×BAR_MIN + prefill)
  SL_ATR_MULT:3.2, MIN_SL_PIPS:6, COST_SL_MULT:6,   // SL = max(3.2×ATR, swing+buffer, 6×biaya, 6 pips)
  SWING_BARS:10, SL_STRUCT_BUF:.5, SL_MAX_ATR:7,    // swing 10 bar sinyal + 0.5×ATR; jika SL > 7×ATR → TOLAK entry
  TP1_R:1.0, TP2_R:2.2, TP1_FRAC:.5,
  COST_EXTRA_PIPS:0,        // slippage + komisi ROUND-TRIP dalam pips, ditambahkan ke biaya. 0 = hanya spread (perilaku lama). Akun raw/commission WAJIB diisi.
  BE_AT_R:.4,                                       // BE lebih awal: di data emas 45h, 0.4R sedikit lebih baik dari 0.6R tanpa menambah sample noise
  PLAN_TTL:60*60000,
  MAX_Z60:2.4, MAX_Z180:2.8,                        // tolak entry saat harga sudah lari (kejar spike)
  /* Pullback-only: tolak entry di ekstrem range 15m. Sweep 45h (TRAIN/TEST 60/40):
     BRK_CEIL 0.88 → avgR negatif di semua pair; 0.55 = satu-satunya titik emas yang hijau di
     TRAIN (+0.112R) dan TEST (+0.125R). Ambang lebih longgar (0.65–0.80) kembali negatif. */
  BRK_CEIL:.55,
  MAX_RETRACE_ATR:1.0,                              // retrace dari ekstrem 3 menit ≤ 1×ATR (momentum masih utuh)
  LOSS_STREAK_N:2, LOSS_STREAK_PAUSE:90*60000,      // 2 loss beruntun → jeda 90 menit
  NEWS_BLACKOUT:[[730,770],[800,830],[835,850],[895,910]], // menit-UTC [mulai,akhir): 12:10–12:50, 13:20–13:50, 13:55–14:10, 14:55–15:10 (rilis AS/ECB/BoE; EDIT sesuai kalender)
  SPIKE_MAX:2.4,
  MAX_DAILY_LOSS_R:3,
  MIN_MOM:.12, MIN_TREND:.12,           // lantai magnitudo faktor utama
  HTF_SOFT:-.08,                        // htf*d harus ≥ ini (toleransi noise kecil)
  BRK_FLOOR:-.55,                       // tolak ekstrem berlawanan dalam
  SESS_EDGE_MS:8*60000,                 // skip 8 menit pertama sesi (noise open)
  CONFIRM_GRACE:6000,                   // toleransi gate kedip selama countdown SETUP (ms)
  BLEED_DECAY:2,                        // setelah grace habis, prog turun 2× kecepatan (bukan nol mendadak)
  DT_CAP:6000,                          // batas waktu antar-evaluasi yang boleh dihitung sebagai konfirmasi
  SOFT_HOLD:.88,                        // angka gate dilonggarkan sekian selama sedang countdown (anti-kedip)
  NEAR_ENTER:.85,NEAR_EXIT:.65,         // hysteresis "nyaris lolos" (× minScore) — masuk di .85, keluar di .65
  W:{mom:.45,trend:.40,brk:.15,flow:.10}
};

/* Titik awal terkalibrasi (walk-forward EURUSDT ~6 hari). Tetap verifikasi dengan backtest.js --sweep pada data akunmu. */
/* minCost diselaraskan dengan pagar EA: spread ≤ 25% ATR ⇒ ATR/spread ≥ 4.0.
   Angka lama 2.2–2.4 menciptakan zona mati (lolos pakar, ditolak terminal) — order hangus + cooldown 15 mnt. */
const MODES={
  precision:{minScore:.55,minER:.36,minCost:4.0,persist:30000,cooldown:25*60000},
  balanced: {minScore:.48,minER:.32,minCost:3.5,persist:20000,cooldown:15*60000},
  /* agresif = mode eksplisit "ingin melihat sinyal", BUKAN mode yang lebih terbukti. Ambang lebih
     longgar + konfirmasi 8 dtk. minCost 2.0 sengaja di bawah pagar EA 4.0: sinyal dashboard tetap
     informatif, tapi AUTO-ORDER bisa menolaknya saat spread nyata > 25% ATR. Baca docs/ANALISIS.md. */
  agresif:  {minScore:.42,minER:.26,minCost:2.0,persist:8000,cooldown:8*60000},
  momentum: {minScore:.44,minER:.28,minCost:3.2,persist:15000,cooldown:12*60000,w:{mom:.55,trend:.30,brk:.10,flow:.10}},
  liquidity:{minScore:.48,minER:.32,minCost:3.5,persist:20000,cooldown:18*60000,needFlow:true},
  auto:     {minScore:.58,minER:.38,minCost:4.0,persist:30000,cooldown:30*60000},
  edge:     {minScore:.65,minER:.42,minCost:4.5,persist:40000,cooldown:45*60000}
};

/* modeFloor = lantai risiko per pair. Mode `agresif` sengaja melewatinya: lantai EURUSD 4.0 /
   XAU 3.8 / ETH 4.0 akan mengembalikan mode longgar ini ke ambang balanced dan seluruh maksudnya hilang. */
function applyModeFloor(mode,cal,modeName){
  if(modeName==='agresif'||!cal||!cal.modeFloor)return mode;
  for(const k of Object.keys(cal.modeFloor)){
    const v=cal.modeFloor[k];if(typeof v==='number'&&typeof mode[k]==='number')mode[k]=Math.max(mode[k],v);
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
  const edge=prm&&prm.SESS_EDGE_MS!=null?prm.SESS_EDGE_MS:PARAMS.SESS_EDGE_MS;
  const d=new Date(t),h=d.getUTCHours(),m=d.getUTCMinutes();
  if(P.h24)return true;
  if(!(h>=P.sess[0]&&h<P.sess[1]))return false;
  if(h===P.sess[0]&&m*60000<edge)return false;
  return true;
}
/* true bila jam UTC t ada di luar prior jam (hours[]) pair — murni informasi, tidak pernah memblokir. */
function outsidePrior(pairKey,t){
  const P=PAIRS[pairKey];
  if(!P||!Array.isArray(P.hours)||!P.hours.length)return false;
  return !P.hours.includes(new Date(t).getUTCHours());
}
function sessionLabel(pairKey){
  const P=PAIRS[pairKey];if(!P)return '';
  const win=P.h24?'24/7 UTC':P.sess[0]+':00–'+P.sess[1]+':00 UTC';
  if(Array.isArray(P.hours)&&P.hours.length)return win+' · prior jam '+P.hours.join(',')+' (label, tidak memblokir)';
  return win;
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
    const sec=ms/1000;if(!s1.length||s1[0].t>sec)return null;
    let lo=0,hi=s1.length-1;
    while(lo<hi){const m=(lo+hi+1)>>1;if(s1[m].t<=sec)lo=m;else hi=m-1}
    return s1[lo].c;
  }
  /* BAR_MIN: semua faktor dihitung di bar N menit (bukan 1 menit). Alasannya terukur: pada 45 hari data nyata,
     ATR 1m FX/emas hanya 1,5–2× spread tetap → biaya memakan seluruh edge (avgR negatif di SEMUA konfigurasi).
     Bar lebih panjang menaikkan rasio ATR/biaya, bukan dengan menambah filter tapi dengan melebarkan horizon. */
  const barMsOf=()=>prm.BAR_MIN*60000;
  function aggregate(bars,n){
    if(n<=1)return bars;
    const out=[];let cur=null;
    for(const b of bars){const g=Math.floor(b.k/n);
      if(!cur||cur.k!==g){cur={k:g,o:b.o,h:b.h,l:b.l,c:b.c};out.push(cur)}
      else{if(b.h>cur.h)cur.h=b.h;if(b.l<cur.l)cur.l=b.l;cur.c=b.c}}
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
  const costPips=()=>Math.max((ask-bid)/P.pip,P.typSpread)+(prm.COST_EXTRA_PIPS||0);

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
    const dist=rd(Math.max(base,sw));
    return{dist,tooFar:dist>prm.SL_MAX_ATR*atr,xAtr:dist/atr};
  }
  function buildPlan(side,t,atr){
    if(!(bid>0&&ask>0))return null;
    const buy=side==='UP',d=buy?1:-1,spread=ask-bid,entry=buy?ask:bid;
    const si=slInfo(side,atr,entry),slDist=si.dist;
    return{id:pairKey+'|'+t+'|'+side,side,pair:pairKey,entry:rd(entry),
      sl:rd(entry-d*slDist),tp1:rd(entry+d*prm.TP1_R*slDist),tp2:rd(entry+d*prm.TP2_R*slDist),
      slDist,atr,atrEst:false,spread,feed,t,expires:t+prm.PLAN_TTL,done:null,tp1hit:false,beArmed:false,resultR:null,slTooFar:si.tooFar,
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
      finish(be?'BE':'SL',tr.tp1hit?F*prm.TP1_R+(1-F)*r:r);return ev;
    }
    if(prm.BE_AT_R>0&&!tr.tp1hit&&!tr.beArmed&&rOf(px)>=prm.BE_AT_R){tr.beArmed=true;tr.sl=tr.entry;ev.push({type:'BE',trade:tr})}
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
    const score=parts.reduce((a,x)=>a+x[0]*x[1],0)/wsum;

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
    let blocked='';
    if(trade)blocked='Plan aktif '+trade.side+' @ '+trade.entry+' — tunggu selesai';
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
      {g:le(volRatio,prm.SPIKE_MAX),t:'Lonjakan volatilitas ×'+volRatio.toFixed(1)+' (hindari saat berita)'}
    ];
    const failed=gates.filter(x=>!x.g.s),sigOK=!failed.length,hardOK=gates.every(x=>x.g.h);
    const coreOK=Math.sign(mom)===d&&Math.sign(trend)===d&&brk>=prm.BRK_FLOOR;

    Object.assign(out,{status:'ok',side,score,confidence:Math.abs(score)*100,
      upProbability:(1+score)/2,downProbability:(1-score)/2,potential:costRatio,alignment:aligned,
      near:Math.abs(score)>=mode.minScore*(holding?prm.NEAR_EXIT:prm.NEAR_ENTER),
      r1m:p/p60-1,r3m:p/p180-1,r15m:p900?p/p900-1:0,priorOut,
      f:{mom,trend,loc,brk,brkN,htf,flow,flowOK,er,atrP,cost,spreadPips,volRatio,costRatio,session:inSess(now),minCost:mode.minCost,minER:mode.minER,minScore:mode.minScore,
        /* z/retrace/SL ikut dibagikan supaya tools/signal_test.js bisa menilai ulang tiap gerbang
           di luar mesin (ablation). Tanpa ini beberapa gerbang tidak bisa direkonstruksi dari rekaman. */
        z60d,z180d,retrace,slTooFar:si.tooFar,side:d}});

    /* --- update latch --- */
    if(cand.side!==side){cand.side=side;cand.prog=0;cand.bleed=0}
    if(hard){cand.prog=0;cand.bleed=0}
    else if(sigOK){cand.bleed=0;cand.prog=Math.min(mode.persist,cand.prog+dt)}
    else if(blocked){/* beku: kandidat bertahan, hanya entry yang ditahan */}
    else if(cand.prog>0&&coreOK){
      cand.bleed+=dt;
      if(cand.bleed>prm.CONFIRM_GRACE)cand.prog=Math.max(0,cand.prog-dt*prm.BLEED_DECAY);
    }else{cand.prog=0;cand.bleed=0}
    out.prog=cand.prog;out.sigOK=sigOK;out.qualified=cand.prog>0||sigOK;
    /* berapa gerbang (soft) yang lolos saat ini — dipakai panel untuk menampilkan kemajuan
       hidup (0..14) meskipun belum satu pun kandidat yang terkunci. Bukan sinyal, hanya ukuran. */
    out.gatesPassed=gates.length-failed.length;out.gatesTotal=gates.length;

    if(!hard&&!blocked&&cand.prog>=mode.persist&&hardOK){
      const plan=buildPlan(side,now,atr);
      if(plan){
        trade=plan;lastEntry=now;cand.prog=0;cand.bleed=0;
        out.stage='ENTRY';out.fired=true;out.confirming=false;out.trade=plan;out.qualified=true;out.prog=mode.persist;
        out.reason=modeName.toUpperCase()+': skor '+score.toFixed(2)+', ER '+er.toFixed(2)+', ATR '+atrP.toFixed(1)+' pips ('+costRatio.toFixed(1)+'× biaya)';
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

const API={PAIRS,PARAMS,MODES,create,summarize,closedFX,isClosed,inSession,outsidePrior,sessionLabel,H24_KEYS:Object.keys(PAIRS).filter(k=>PAIRS[k].h24),FX_HOLIDAYS:[...FX_HOLIDAYS].sort()};
if(typeof module!=='undefined'&&module.exports)module.exports=API;else root.FXEngine=API;
})(typeof window!=='undefined'?window:globalThis);
