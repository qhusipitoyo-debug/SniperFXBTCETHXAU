# FX Majors Sniper

Dikonversi dari XAUUSD Sniper. Semua berjalan lokal di browser — scanner informational only, tidak ada order, tidak ada koneksi ke terminal broker apa pun. mulai v8, tapi mati secara default, DRY RUN secara default, dan hanya mau jalan di akun demo (lihat [Auto-order MT5](#auto-order-mt5-demo-saja--v8)).

## Pair (dropdown kiri atas, atau `?pair=EURUSD`)

EUR/USD (Fiber) • USD/JPY (Gopher) • GBP/USD (Cable) • USD/CHF (Swissie) • AUD/USD (Aussie) • USD/CAD (Loonie) • NZD/USD (Kiwi)

## Feed (dropdown kanan, atau `?feed=binance|oanda|capital`)

| Feed | Perlu proxy? | Pair tersedia | Catatan |
|---|---|---|---|
| **Binance (USDT)** | Tidak | EUR/USD saja | `EURUSDT` punya buku order nyata. **`GBPUSDT` dan `AUDUSDT` sudah tidak bisa dipakai** — `bookTicker`-nya mengembalikan `0.00000000` untuk bid/ask, jadi tidak ada harga. Pair lain tidak ada pasangan USD-nya di Binance. |
| **Deriv (publik)** | Tidak | Ketujuhnya | Tanpa akun/token: langsung ke `wss://api.derivws.com/trading/v1/options/ws/public`, symbol `frxEURUSD` dst. Hanya bid/ask (atau quote tunggal → spread disimulasikan 0.8 pips), 3 faktor. Tick lebih jarang dari Binance/broker. Pasar tutup di weekend. |
| **OANDA** | Ya | Ketujuhnya | Harga broker asli (v20 practice gratis). Hanya bid/ask → 3 faktor (tick-rule). |
| **Capital.com** | Ya | Ketujuhnya | Harga broker asli (demo gratis). Hanya bid/ask → 3 faktor. |

Untuk USD/JPY, USD/CHF, USD/CAD, NZD/USD pakai **Deriv** (paling mudah, tanpa daftar), OANDA, atau Capital.com — Binance tidak punya pasangannya.

## Jalankan

Panel adalah berkas statis — satu server kecil di folder ini sudah cukup:

```bash
python3 -m http.server 8080          # buka http://localhost:8080
```

Jangan jalankan dua kali: port 8080 biasanya sudah dipegang autostart, dan python akan keluar dengan
`OSError: [Errno 98] Address already in use`. Cek dengan `bash tools/autostart.sh --status`; kalau panel
sudah jalan, buka saja `http://127.0.0.1:8080` (pakai angka, bukan nama `localhost`, kalau browsermu
lewat proxy/VPN — proxy sering ikut menyeret `localhost` lalu menolak koneksi).

```bash
bash tools/autostart.sh              # nyalakan panel setelah login; --status untuk melihat saja
```

Statistik per pair (panel "🏆 STATISTIK PER PASANGAN") dibaca dari `stats/pair_stats.json`. Berkas itu
tidak ikut terkirim — buat sekali:

```bash
node tools/pair_stats.js             # ±15 menit: replay engine atas data lokal, semua pair × semua mode
node tools/collector.js              # daemon: kumpulkan plan 24/7 ke stats/live_ledger.jsonl walau tab tertutup
```

Langkah proxy hanya untuk feed OANDA / Capital.com.

Satu koneksi broker melayani ketujuh pair; browser memfilter sesuai pair terpilih, jadi ganti pair instan.
Token broker hanya ada di `.env`, tidak masuk browser. Proxy listen di `127.0.0.1` dan hanya menerima origin di `ALLOW_ORIGINS`.
Kalau web app di-host online, proxy lokal tidak terjangkau — deploy proxy sendiri dengan `wss://` dan buka `?proxy=wss://domain-proxy`.

## Kalibrasi (WAJIB sebelum percaya sinyal)

Parameter di `engine.js` (`MODES`, `PARAMS`, `typSpread`, `sess`) adalah **titik awal yang masuk akal, bukan hasil optimasi**.

### Alat kalibrasi walk-forward (v7)

```bash
# 1) tarik bar 1 menit dari Binance (publik, tanpa key) → data/<SYM>_1m.csv  format ts,bid,ask
node tools/fetch_klines.js                      # default EURUSDT PAXGUSDT BTCUSDT ETHUSDT, ±45 hari
node tools/fetch_klines.js EURUSDT --days 90

# 2) pencarian koordinat greedy di TRAIN (60%) + SATU validasi di TEST (40%)
node tools/calibrate.js                         # 4 worker, satu aset per worker (RAM)
node tools/calibrate.js --report                # evaluasi ulang config default tanpa pencarian

# 3) regression anti-kedip & UI headless
node tools/latch_test.js                        # episode SETUP, progress, % kartu terpaku saat plan aktif
node tools/ui_smoke.js                          # DOM/WS stub: error runtime, churn board/jam
FX_SNIPER_EMPTY_STATS=1 node tools/ui_smoke.js  # belum ada berkas stats: panel harus tetap lengkap
FX_SNIPER_STALE_DAEMON=1 node tools/ui_smoke.js # collector mati: ledger boleh tampil, "aktif" tidak
node tools/collector.js --replay data/ETHUSDT_1m.csv --pairs ETHUSD   # jalur ingest daemon tanpa jaringan
node backtest.js data/EURUSDT_1m.csv --pair EURUSD --mode balanced

# 4) uji apakah ARAH itu sendiri membawa informasi (tanpa SL/TP/BE sama sekali)
node tools/signal_test.js data/EURUSDT_1m.csv --pair EURUSD --horizon 15
node tools/signal_test.js data/PAXGUSDT_1m.csv --pair XAUUSD --horizon 60 --boot 3000
```

Yang disapu `tools/calibrate.js`: `BAR_MIN` (timeframe bar sinyal 1/3/5/15 m), `minScore`, `minER`, `minCost`, `persist`, `cooldown`, `SL_ATR_MULT`, `TP1_R`, `TP2_R`, `MIN_MOM/MIN_TREND`, `HTF_SOFT`, `BRK_CEIL`. Aturan baca hasilnya tetap sama: percaya hanya konfigurasi yang positif di **TEST** (n ≥ 30, PF > 1.1) dan berada di plateau.

### Hasil kalibrasi pada data nyata — dibaca sebelum memakai uang

**Ulangan 31-10-2026 (permintaan eksplisit: "carikan model yang profit, walau sedikit").** Data yang sama (45 hari, 259 200 baris 15 dtk per aset), `backtest.js --sweep` 81 kombinasi untuk EURUSD dan XAUUSD (split 60/40, evaluasi tiap 5 dtk), ditambah `tools/walkforward.js` (97 kombinasi × 4 fold bergerak-maju, dinilai dari fold **terburuk**, tiap kombinasi di worker terpisah). Hasilnya:

- **Tidak ada satu pun kombinasi yang positif di TRAIN.** Daftar "TOP 8 di TRAIN" untuk EURUSD dimulai dari `avgR −0,010` (n=32, PF 0,94) — bukan negatif karena ambangnya terlalu tinggi, tapi karena puncak ruangnya sendiri sudah di bawah nol. XAUUSD sama (`−0,010 … −0,037`). TRAIN yang sudah negatif membuat TEST yang positif (EURUSD #5–#8: `n=41 avgR +0,035 PF 1,24`) otomatis tidak berarti: itu pola klasik kurva-fit, bukan edge. Putusan alat, kedua pair: ✘ tidak ada bukti edge pada data ini.
- **Satu-satunya angka positif yang pernah muncul (+1,16 R, PF 1,07, n=103 pada `momentum`/EURUSD) adalah artefak biaya.** CSV hasil `tools/fetch_klines.js` memakai `typSpread` Binance — 1 pip untuk EURUSD, padahal FBS memungut ±2,8 pip di simbol yang sama. Kalau spread datanya dinaikkan jadi 2,8 pip (mid tidak diubah, jadi sinyalnya identik dan hanya biaya eksekusinya yang nyata: `/tmp/EURUSD_fbs.csv`), kedua mode menghasilkan **n = 0** — nol trade, bukan rugi. Penyebabnya aritmetika dan sudah kelihatan dari terminal: ATR(M15) EURUSD ±5,3 pip vs spread 2,8 pip = rasio 1,89×, di bawah `minCost` mode mana pun (2,2–3,2). Jadi angka +1,16 R itu berarti "profit kalau biaya hampir tidak ada", dan angka itu bukan strategi yang bisa dipakai.
- Yang justru **tidak** bisa dibuang dengan alasan biaya adalah emas dan BTC: di sana ATR/biaya besar (XAUUSD 16,6×, BTCUSD 5,7× di terminal barusan) sehingga sinyalnya memang lolos audit biaya — dan hasilnya tetap minus (balanced penuh: XAUUSD −4,31 R, BTCUSD −17,59 R; sapuan grid: tidak ada TRAIN positif). Kesimpulannya bukan "biayanya kemahalan", tapi "pada 45 hari ini mesin sinyalnya tidak punya edge yang menutupi biaya".
- Batas yang tidak dilewati demi angka: ambang `minCost`/`minScore`/`minER` tidak diturunkan supaya sweep menemukan sesuatu yang positif, dan fold validation tetap menilai dari fold terburuk. Kalau suatu hari ada konfigurasi yang lolos, ia harus positif di SEMUA fold dengan n ≥ 30 per fold — bukan satu potongan TEST yang kebetulan hijau.
- **Walk-forward 4 fold (`tools/walkforward.js`, 97 kombinasi × EURUSD/XAUUSD, mode balanced + momentum): tidak ada satu pun konfigurasi yang positif di semua fold.** Yang paling dekat pun `2/4 fold negatif` (EURUSD terbaik: TRAIN −0,003 R, TEST `22tr/+0,019 · 18tr/−0,049 · 20tr/+0,163 · 20tr/−0,053`, agregat +1,76 R atas 80 trade). XAUUSD lebih buruk: TRAIN −0,136 R dan agregat TEST −0,01 R. Potongan test per fold ±9 hari = 3–22 trade, jadi ini belum bisa disebut "terbukti tidak ada edge selamanya" — tapi pada 45 hari ini, tidak.

**Diagnosis MFE/MAE — sekarang ada di engine, dan jawabannya mengubah kesimpulan di atas.** Yang diadopsi dari [trade-ai](https://github.com/Rishabh-27-Devloper/trade-ai) bukan sistemnya (Python/Flask/SQLite/EC2 + satu otak order terpisah di atas akun yang sama = dua penulis, satu kebenaran), melainkan dua idenya: **excursion per trade** dan **biaya eksplisit di luar spread**. Di `engine.js`: tiap trade menyimpan `mfe`/`mae` (puncak profit/puncak rugi dalam R, diukur di harga sisi keluar jadi sudah termasuk spread), `summarize()` menambah `mfeAvg`/`maeAvg`/`geoMiss` (rugi padahal sudah pernah ≥1R = salah keluar) / `dirMiss` (rugi tanpa pernah +0,5R = salah arah), dan `PARAMS.COST_EXTRA_PIPS` (slippage+komisi round-trip dalam pips, dipakai `costPips()` untuk audit DAN dipotong dari `resultR` saat close; default 0 = perilaku lama, jadi angka live tidak berubah diam-diam). `backtest.js --cost-extra <pips>` dan `tools/walkforward.js --cost-extra <pips>` mencetaknya di baris "Diagnosis MFE/MAE".

Hasilnya, 10 lintasan (4 pair × balanced/momentum, 1 600+ trade) seragam sampai mencurigakan:

| pair/mode | n | avgR | mfe rata | mae rata | rugi ≥1R sebelumnya | rugi tanpa pernah +0,5R | exit TIME |
|---|---|---|---|---|---|---|---|
| EURUSD balanced | 73 | −0,059 | +0,28R | −0,32R | **0%** | 52% | 69/73 |
| EURUSD momentum | 103 | +0,011 | +0,34R | −0,33R | **0%** | 50% | 93/103 |
| XAUUSD balanced | 92 | −0,047 | +0,29R | −0,33R | **0%** | 58% | 88/92 |
| XAUUSD momentum | 123 | −0,063 | +0,28R | −0,34R | **0%** | 58% | 115/123 |
| BTCUSD balanced | 263 | −0,067 | +0,28R | −0,33R | **0%** | 56% | 250/263 |
| BTCUSD momentum | 353 | −0,058 | +0,29R | −0,33R | **0%** | 53% | 325/353 |
| ETHUSD balanced | 241 | −0,063 | +0,30R | −0,35R | **0%** | 61% | 228/241 |
| ETHUSD momentum | 330 | −0,057 | +0,30R | −0,34R | **0%** | 57% | 307/330 |

- **`geoMiss` = 0% di semua lintasan.** Tidak ada satu pun trade rugi yang sempat menyentuh +1R (TP1). Jadi TP1/TP2/BE/time-stop bukan penyebab kerugian — posisi-posisi itu memang tidak pernah jalan. Memperbaiki geometri keluar tidak akan menolong; ini jawaban yang sebelumnya tidak bisa dibedakan dari data avgR saja.
- **`mfeAvg` ≈ +0,29R vs `maeAvg` ≈ −0,33R, di semua pair.** Puncak profit dan puncak rugi hampir simetris dan keduanya kecil: persis bentuk yang dihasilkan tebakan arah tanpa informasi. Ditambah `dirMiss` 50–61% (setengah lebih loser tidak pernah lewat +0,5R), kesimpulannya **yang bermasalah adalah arah/filtered entry, bukan exit dan bukan (semata-mata) biaya**.
- 88–93% penutupan adalah `TIME` (time-stop 60 menit) dengan mfe 0,25–0,28R: tesis plan kedaluwarsa, bukan terhenti di SL atau TP. Untuk trade yang benar-benar menang (`TP2`) mfe-nya 2,3–2,5R dengan mae −0,1…−0,2R — saat arahnya benar, ia benar sejak awal dan tidak pernah melihat ke bawah. Itu sebabnya sampel winner kecil ini tidak bisa diperbesar-besarkan jadi "kalau filter diperketat akan profit".
- Sensitivitas biaya, terukur bukan diasumsikan: XAUUSD `--cost-extra 1.5` (spread CSV 3 pips vs FBS 4,5 pips) → totalR −4,31 → −4,90 (≈ −0,006 R/trade). Biaya nyata tapi bukan penjelas utama; sedangkan EURUSD justru murni biaya (ATR 5,3 pip vs spread FBS 2,8 pip, lihat di atas) sehingga dengan spread yang benar **n jadi 0** — dan `--cost-extra 0.5` di atas data FBS itu tetap 0 trade.

Konsekuensi jujurnya untuk pencarian "model yang profit": menaikkan `minScore`/memperketat filter sampai `geoMiss` bergerak tidak akan membantu, karena trade yang rugi pun tidak pernah mendekati TP1. Yang tersisa adalah mempersoalkan sumber arah itu sendiri (horizon `BAR_MIN`, bobot `mom`/`trend`/`htf`, dan fakta bahwa 45 hari data 15-dtk hanya menghasilkan 73–353 trade per konfigurasi) — bukan menggeser ambang.

**Kalimat itu ditulis sebagai rencana; [jesse-ai/jesse](https://github.com/jesse-ai/jesse) adalah yang membuatnya jadi terukur.** Repo-nya MIT, masih berkembang (rilis 3.5.4, commit terakhir sehari sebelum log ini), dan seperti sebelumnya yang diambil bukan sistemnya — Python + PostgreSQL + pipeline candle sendiri, sementara `engine.js` kita ikut dimuat browser lewat `app.js`; memportasinya hanya mengganti satu sumber-kebenaran dengan dua. Yang diambil: (i) **uji-sinyal-saja** (`Strategy._execute_for_signal_test`) — jalankan keputusan arah TANPA mensimulasikan posisi, nilai tiap sinyal dengan return jendela berikutnya yang sudah di-detrend, lalu bandingkan dengan nol lewat **stationary block bootstrap** (Politis–Romano, blok geometris) supaya korelasi serial tidak menyamar jadi edge; (ii) konsep **`filters()` sebagai predikat bernama** — dipakai terbalik jadi ablation: satu gerbang dilepas, apa yang terjadi pada edge; (iii) beberapa **ukuran kualitas yang tidak bergantung rata-rata R**.

Yang TIDAK ada di jesse dan kita tidak kehilangan apa pun: grep `slippage` di seluruh repo = **nol** (biaya hanya fee proporional), tidak ada walk-forward (hanya split train/test yang dipasang pemanggil), dan tidak ada MFE/MAE sama sekali. Pada dua instrumen terakhir mesin kita justru lebih maju — dan itu yang bikin diagnosis exit-vs-arah di atas bisa ditulis.

Alatnya: `node tools/signal_test.js data/EURUSDT_1m.csv --pair EURUSD [--horizon 15|60] [--boot 3000]`. `engine.js` hanya menambah empat angka ke `f` (`z60d`,`z180d`,`retrace`,`slTooFar`) supaya gerbang bisa dinilai ulang di luar mesin — tambahan, tidak mengubah satu pun angka live. Hasil 45 hari, 4 pair, mode balanced (edge dalam **satuannya ATR**, detrend global, 4 305 sampel tidak tumpang tindih pada jendela 15 mnt):

| pair | arah SEMUA sinyal 15 mnt | 60 mnt | setelah gerbang (15 mnt) | drag spread |
|---|---|---|---|---|
| EURUSD | −0,006 ATR • p=0,58 | +0,025 • p=0,59 | +0,015 • p=0,79 (n=181) | −0,28 ATR |
| XAUUSD | **−0,045 • p=0,010** | **−0,206 • p=0,006** | −0,098 • p=0,23 (n=182) | −0,17 ATR |
| BTCUSD | −0,005 • p=0,70 | −0,010 • p=0,85 | −0,030 • p=0,74 (n=295) | −0,14 ATR |
| ETHUSD | +0,006 • p=0,62 | +0,030 • p=0,56 | −0,068 • p=0,72 (n=281) | −0,23 ATR |

- **Alatnya diuji sebelum datanya dibaca.** Baris E di tiap keluaran adalah kontrol diri: `nabi` (arah = tanda return yang *sudah terjadi*) harus tertangkap → p=0,000, edge +0,49…+0,69 ATR di semua pair; `koin` (arah undian) harus lolos → p=0,55…0,83. Jadi "✘ tidak terbedakan dari nol" di atas adalah sifat datanya, bukan alat yang tumpul.
- **EURUSD/BTC/ETH: arah mesin tidak bisa dibedakan dari koin.** Di kedua horizon, di semua subset. Ini menutup pertanyaan yang ditinggalkan `dirMiss` 50–61% dengan bukti signifikansi, bukan dengan perasaan.
- **XAUUSD satu-satunya yang informatif — dan tandanya salah.** Sinyal arah emas *signifikan* sebesar −0,045 ATR (15 mnt) dan −0,206 ATR (60 mnt): mesin secara sistematis berdiri di sisi yang berlawanan. Konsisten dengan mekanismenya: sisi awal dihitung dari `.45*mom + .40*trend + .15*htf` = mengejar momentum, dan emas intraday 45 hari ini menghukum pengejar momentum. **Tidak, membalik sinyalnya bukan strategi yang boleh langsung dipakai** — subset yang benar-benar akan ditrade-kan (lolos semua gerbang) −0,098 ATR dengan p=0,23 dan n=182, dan "saya menemukan edge dengan membalik di data yang sama" adalah persis klaim yang sudah dihukum walk-forward di atas. Yang boleh diklaim baru sebatas: sumber arah (mom/trend) adalah tempat mencari, bukan ambang.
- **Biaya lebih besar dari candidate edge mana pun.** Drag spread terukur 0,09–0,28 ATR per trade; edge terbesar yang pernah muncul di tabel ini adalah +0,21 ATR dengan n=48 dan p=0,40. Pada pair yang spread-nya 0,23–0,28 ATR, arah harus benar seperempat-ATR lebih sering dari acak — dan yang terukur adalah 0,00–0,03.
- **Ablasi menampar satu gerbang: `BRK_CEIL` ("di ekstrem range 15m — tunggu pullback") adalah yang paling memperbaiki edge saat dibuang** (EURUSD 0,004 → 0,043; XAUUSD −0,098 → −0,018) — dan ini *bertentangan* dengan temuan sweep di atas yang bilang memperketat `BRK_CEIL` 0,88 → 0,75 menaikkan avgR. Keduanya bisa benar karena avgR diukur sesudah geometri keluar dan biaya, sedangkan signal_test mengukur drift mentah; tapi pertentangan itu harus diselesaikan, bukan dipilih yang enak. Gerbang `Mom&trend searah`, `Brk floor`, `flow`, `spread`, `spike` **tidak pernah menolak satu pun sampel** pada stride ini (kolom "hilang" = kolom "n lolos") — itu kandidat dekorasi, bukan penjaga.
- Ukuran kualitas baru di `summarize()` (juga lewat `backtest.js`, blok "Ukuran kualitas"): `winLossRatio`, `upsPct`/`winUp`/`winDown`, `holdWin`/`holdLoss`, `sharpe`/`smartSharpe`. Untuk XAUUSD balanced: 63% UP dengan win 39,7% vs DOWN 38,2% (asimetri arahnya nyata tapi kecil), tahan menang 60 mnt vs rugi 59 mnt → **tidak ada bias hold-loser**, dan hukuman serial hanya 1,08× → Sharpe-mu tidak sedang ditopang trade yang berdempetan. Semua kunci baru null-safe, jadi `{resultR}`-saja dari `app.js:599` tetap jalan.

Regresi setelah perubahan ini tidak berubah: `bridge_test` 91, `scanner_test` 51, `bridge_http_test` 34, `latch_test`, `ea_sim`, `ui_smoke` (dua mode) semuanya exit 0.

**Lanjutan 31-10-2026 sore.** Baris di atas ditulis sebelum `tools/scanner_test.js` benar-benar dijalankan setelah perbaikan edge — dan waktu dijalankan ia crash. Sekarang klaim itu benar, plus satu pengukuran baru yang mengubah pertanyaannya.

*Rantai yang patah: §C/§F/§G mati karena R9, bukan karena scanner.* Sesi pagi menaikkan ekuitas fixture 1 000 → 10 000 (untuk lolos R5: ATR M15 BTC ±480 pip membuat lot < 0,01 pada saldo $1 000), tapi `maxOpenRiskUsd` tetap 20 dari `DEFAULTS`. `riskUsd = 1% × ekuitas` ikut naik 10× → `$100 > ruang $20` → `guardDecide` menolak SEMUA submit, `state.orders` tetap kosong, dan §G crash di `rt.state.orders[0].ack`. Fix-nya di fixture (`tools/scanner_test.js`: `maxOpenRiskUsd: 250`), bukan di pagar: R9 membandingkan plafon dengan risiko yang memang ikut ekuitas, jadi fixture yang menaikkan ekuitas 10× wajib menaikkan plafon 10× atau yang diuji jadi "guard bekerja" terus-menerus. Produksi tidak pernah kena: saldo $1 056 → risiko $10,56 vs plafon $20.

*Dua assertion yang salah, bukan kode yang salah.* §G membandingkan `plan2.entry` dengan `ask` sementara plan-nya DOWN (dijual di bid) → selisih spread 20 points terbaca sebagai 2 000 points "meleset"; sekarang side-aware seperti §F. §I ("pagar spread EA ditiru scanner") gagal dengan cara yang lebih instructive: `fired = 0`, nol kejadian, seolah pagarnya tidak pernah diuji.

*Zona mati pagar EA tidak bisa dicapai dengan melebarkan spread — dan fixture-nya diam-diam menguji hal lain.* Plafon EA = `max(30 pts, 25% × ATR)`; di jendela replay ini ATR(M15) BTC = 480 pip ⇒ plafon 120 pip, sedangkan `PAIRS.BTCUSD.maxSpread` engine = 60 pip. Spread mana pun yang melewati pagar EA sudah membunuh sinyal di engine lebih dulu, jadi yang diukur §I adalah "tidak ada fire", bukan "fire ditahan terminal". Dua perbaikan: (i) `writeStatus` melebarkan spread **simetris terhadap mid** — `engine.js:284` memakai `p=(ask+bid)/2` untuk semua fitur (z, ema, HTF, loc), jadi menurunkan bid saja menggeser seluruh jalur harga dan sinyalnya hilang bukan karena biayanya; (ii) argumen `atrRatio` — spread data dibiarkan apa adanya, ATR dilaporkan 3,85× spread, dan itu justru kasus produksi yang benar (EA membandingkan dengan ATR-nya sendiri). Konsekuensi yang perlu dicatat sebelum ada yang "memperbaiki" ini: setelah `minCost` diselaraskan ke 4,0 (precision/auto), mesin dan pagar EA jatuh pada rasio yang sama dan zona mati hanya tersisa di mode ber-minCost < 4 (balanced 3,5 / momentum 3,2 / liquidity 3,5).

*Koneksi: yang mati dan yang perlu reload.* Terminal MT5 tidak jalan (status EA basi 960 dtk, `pricesFresh:false`, watchdog menahan semuanya) → `bash tools/autostart.sh` menyalakan bottle + bridge + panel; status segar 1 dtk kemudian. Build EA yang jalan kini `2026.10.31 19:41` — compile pagi dengan `InMaxSpreadAtrPct = 25.0` baru kelihatan setelah terminal di-restart, persis catatan `SniperBridge.mq5:734`: compile ulang TIDAK otomatis me-reload chart.

*Rasio biaya live, terukur dari `sniper_status.txt` barusan (ATR/spread):* XAUUSD **16,6×** dan BTCUSD **4,12×** lolos ambang 3,5; sisanya EURUSD 1,89, USDJPY 1,84, ETHUSD 1,44, GBPUSD 1,14, USDCAD 1,12, USDCHF 1,04, NZDUSD 0,82, AUDUSD 0,72. Penyelarasan biaya jadi menyusutkan semesta yang bisa ditrade-kan ke dua simbol, dan itu konsekuensi bukan bug — di FBS spread FX major ±2,8 pip vs ATR(M15) ±5,3 pip, jadi pasangan itu tidak pernah memenuhi syarat biaya apa pun di atas 2,0×.

*Backtest 45 hari dengan parameter yang tadi diterapkan (balanced):* XAUUSD `n=14 avgR +0,065 PF 1,42`; BTCUSD `n=48 avgR −0,058 PF 0,61` — dan BTC-lah yang paling sering fire di live. Angka emas tidak boleh dijual: n=14, 12 dari 14 penutupan adalah TIME, dan klaim "hijau di TRAIN dan TEST" yang jadi dasar `BRK_CEIL .55` diukur di potongan yang sama.

*Sinyal emas adalah anti-sinyal, dan ia membesar bersama horizon.* `tools/signal_test.js` baru dijalankan pada 15 dan 60 menit; dijalankan juga di 180 menit (stride = horizon, jadi sampel tidak tumpang tindih), edge dalam ATR:

| pair | 15 mnt | 60 mnt | 180 mnt | drag spread |
|---|---|---|---|---|
| XAUUSD | **−0,056 • p=0,001** | **−0,192 • p=0,008** | **−0,850 • p=0,001** (n=358) | −0,17 |
| BTCUSD | −0,001 • p=0,94 | −0,022 • p=0,68 | −0,042 • p=0,81 | −0,14 |

- Sisi per sisi di 180 mnt: UP −0,635 (n=159) dan DOWN −1,023 (n=199) — **keduanya negatif**, jadi ini mesin yang berdiri di sisi yang salah, bukan artefak satu 45 hari di mana emas hanya turun. Kontrol `nabi`/`koin` tetap lulus (p=0,000 / p=0,82), jadi angkanya milik datanya.
- BTC datar di nol pada ketiga horizon. Tidak ada yang bisa dibalik di sana; satu-satunya pasangan yang informasinya nyata adalah emas.
- Yang menahan klaim, dan untuk sekarang ini deciding: pada horizon 3 jam hanya **n=2** sinyal yang lolos seluruh gerbang (14 di 15 mnt). Rangkaian `minCost`/`minER`/`BRK_CEIL`/retrace dikalibrasi untuk horizon 15 mnt — fade 3 jam butuh gerbang dan geometri keluar yang cocok sendiri, bukan gerbang lama plus sisi dibalik. Ditambah lagi 358 sampel dari 45 hari bukan bukti out-of-sample, dan "edge ditemukan dengan membalik di data yang sama" adalah persis klaim yang sudah dihukum `tools/walkforward.js` di atas. **Tidak ada satu baris pun `engine.js` yang diubah untuk inversion ini.**
- Langkah berikutnya yang jujur bukan kode tapi data: 6–12 bulan lewat `tools/fetch_klines.js`, lalu fold bergerak di horizon yang sama. Tanpa itu apa pun yang hijau di 45 hari cuma pergantian tebakan.

**Dan jawabannya: anti-sinyal emas itu tidak nyata.** Yang di atas ditulis sebagai hipotesis; hipotesisnya sudah diuji dan jatuh. `tools/fetch_klines.js PAXGUSDT BTCUSDT --days=365` (525 605 bar 1m, 2025-10-31 → 2026-10-31, spread dipasang `typSpread` FBS 4,5/20 pips seperti sebelumnya; salinan 45 hari lama ada di `data/archive_45d/`, potongan setengah tahun di `data/PAXG_1H.csv` / `PAXG_2H.csv`), `signal_test.js --horizon 180 --stride 180 --eval 300000`:

| jendela XAUUSD (180 mnt) | n | edge | p | tanda |
|---|---|---|---|---|
| 45 hari (yang di atas) | 358 | −0,850 ATR | 0,001 | salah arah |
| setengah tahun I (2025-11 → 2026-04) | 1 458 | **+0,178 ATR** | 0,092 | benar arah, tak terbedakan |
| setengah tahun II (2026-04 → 2026-10) | 1 458 | **−0,052 ATR** | 0,642 | tak terbedakan |
| BTCUSD setahun penuh | 2 918 | +0,028 ATR | 0,639 | tak terbedakan (UP +0,050 / DOWN +0,006) |

- **Tandanya berpindah antar-paruh dan tidak ada satu pun yang signifikan di 5%.** Angka −0,850 ATR p=0,001 yang kelihatan paling menggodai di log ini adalah sifat 45 hari itu, bukan sifat mesin maupun sifat emas. Persis yang diantisipasi kalimat "edge ditemukan dengan membalik di data yang sama": begitu diukur di data yang belum dilihat, efeknya hilang — bahkan berbalik. Fade XAUUSD tidak diimplementasikan, dan tidak akan, kecuali suatu ketika muncul positif di SEMUA fold dengan n ≥ 30 per fold.
- Kontrol alat tetap lulus di tiap lintasan (`nabi` edge +2,3…+2,6 ATR dengan p=0,000; `koin` p=0,87), dan bootstrap-nya jalan di 1 458–2 918 sampel non-overlapping — jadi "tidak terbedakan dari nol" kali ini diucapkan dengan tenaga statistik yang memadai, bukan dengan sampel kecil.
- Drag spread tetap batu yang sama: −0,12…−0,24 ATR per trade pada pair ini. Edge terbesar yang bertahan di setahun adalah +0,18 ATR dengan p=0,09; untuk menutupi biaya, arah harus benar sekitar satu-sepersempat-ATR lebih sering dari acak. Tidak sedekat itu di mana pun.
- Kesimpulan operasional, dan ini yang berubah dari sore ini: **dua simbol yang secara biaya boleh ditrade-kan (XAUUSD, BTCUSD) tidak membawa informasi arah pada horizon 15, 60, maupun 180 menit — termasuk pada data setahun.** FX major tidak sempat diuji setahun karena tersingkir lebih awal: dengan spread FBS ±2,8 pip vs ATR(M15) ±5,3 pip (rasio 1,9×) jumlah trade-nya 0 di mode mana pun, jadi pertanyaannya bukan lagi "sinyalnya bagus atau tidak" tapi "biayanya tidak akan pernah tertutup". Tidak ada konfigurasi gerbang/exit yang bisa mengubah salah satunya, karena `geoMiss = 0%` sudah menutup sisi exit. Bridge tetap di `dryRun` bukan karena perbaikannya belum selesai, tapi karena tidak ada yang layak dikirim: koneksi ke terminal sudah terbukti (status 1 dtk, ack bolak-balik, §C/§F/§G/§I hijau), dan yang belum terbukti hanyalah sinyalnya.

**Verifikasi penutup — horizon 15 menit pada tahun yang sama, karena angka 15 menit itulah yang selama ini dipakai mesin.** `--horizon 15 --stride 15 --eval 120000`: 32 836 sampel tidak tumpang tindih per pair (≈10× tenaga statistik 45 hari; pita nol 95%-nya menyempit ke ±0,013 ATR, jadi efek sekecil 0,045 yang dulu "signifikan" itu sekarang harusnya kelihatan kalau memang ada).

| 15 menit, 365 hari | n | edge kotor | p | drag spread | setelah biaya |
|---|---|---|---|---|---|
| XAUUSD — semua sinyal | 32 836 | −0,006 | 0,366 | **−0,188** | −0,194 |
| XAUUSD — lolos semua gerbang | 135 | +0,127 | 0,093 | −0,081 | +0,046 |
| BTCUSD — semua sinyal | 32 837 | −0,002 | 0,668 | **−0,127** | −0,129 |
| BTCUSD — lolos semua gerbang | 161 | +0,028 | 0,637 | −0,101 | −0,073 |

- **Drag tetap dominan, dan sekarang terukur dengan sampel yang layak.** Pada seluruh sinyal, |edge| ≤ 0,006 ATR lawan drag 0,127–0,188 ATR: rasionya 20–30×, bukan 2×. "Anti-sinyal emas −0,045/p=0,010" dari 45 hari tidak bertahan: di setahun angka itu menguap jadi −0,006 dengan p=0,366. Kombinasi 60 + 180 + 15 menit sekarang semuanya bilang hal yang sama.
- **Satu-satunya sisi yang pernah tampak hidup adalah subset yang lolos gerbang** (XAU +0,127 kotor / +0,046 bersih, n=135). Ia diperiksa dengan cara yang sama seperti klaim sebelumnya dan **gagal lagi**: paruh I `n=93 edge +0,176 p=0,040`, paruh II `n=40 edge −0,032 p=0,759`. Tanda berpindah antar-paruh untuk ketiga kalinya di data ini — pola yang konsisten, dan bukan pola yang mendukung tesisnya. Tidak ada yang di-arm.
- **Drag-nya sendiri bukan konstanta, dan bergerak ke arah yang salah.** Paruh I −0,142 ATR vs paruh II −0,234 ATR ( unconditional ), sementara subset ber-gate menahan hanya 135 → 93 → 40 sinyal. Asumsinya spread 4,5 pip konstan; yang berubah adalah ATR-nya (mengecil), jadi 6 bulan terakhir justru lebih sedikit layak ditrade-kan, bukan lebih banyak. Ini alasan kedua — setelah "tidak ada edge" — mengapa ambang biaya tidak boleh diturunkan untuk "mencari sesuatu".
- **Yang justru terverifikasi positif: `BRK_CEIL`.** Pertentangan yang ditinggalkan sesi pagi (sweep bilang memperketat BRK_CEIL 0,88 → 0,55 menaikkan avgR; ablasi 45 hari bilang gerbang itu menghalangi sinyal bagus) **selesai ke arah sweep** pada sampel yang lebih besar: melepas `Brk ceil` di setahun menurunkan edge XAUUSD 0,127 → 0,015 (Δ −0,112 — di tabel ini Δ negatif = gerbang berguna). `Skor` (−0,091) dan `ER` (−0,074) juga berguna. Satu-satunya Δ positif adalah `ATR/biaya` sendiri (+0,031): dia memang menahan sinyal yang drift-nya lebih baik — tapi gerbang biaya (bersama `Skor`/`ER`/`Brk ceil`) itulah yang menurunkan drag dari −0,188 ke −0,081, dan menukar 0,03 ATR drift dengan 0,10 ATR biaya adalah tukar yang benar untuk mesin yang hidup dari selisih kecil. Tujuh gerbang lainnya **tetap tidak pernah menolak satu pun sampel dalam setahun** (`Mom&trend searah`, `Brk floor`, `flow`, `z jangan kejar`, `SL swing valid`, `spread`, `spike`; kolom "hilang" = kolom "n lolos") — itu kandidat dekorasi, bukan penjaga, dan itu belum berubah.
- Batas yang tidak dilewati: tidak ada satu pun ambang diturunkan, `autoArm` tetap `false`, `dryRun` tetap `true`. Data 45 hari lama tidak ditimpa di tempat lain (salinan di `data/archive_45d/`), dan `EURUSDT`/`ETHUSDT` memang tidak ikut di-fetch ulang — keduanya sudah mati di sisi biaya sebelum pertanyaan sinyalnya sampai dijawab.

Status setelah lanjutan ini: `dryRun=true`, `autoArm=false`, tidak ada order live yang dikirim. Regresi benar-benar hijau: `bridge_test` 91, `scanner_test` 51, `bridge_http_test` 34, `ea_sim` 11 langkah, `ui_smoke` 0 error runtime.

**Repo ketiga yang dievaluasi dan ditolak utuh: [TheUnknown550/AI-Trading-System](https://github.com/TheUnknown550/AI-Trading-System)** (MIT, 175 MB, 44 model RandomForest ter-commit, commit terakhir Okt 2025). Ditolak bukan karena selera: targetnya sendiri jujur (`train_models.py:49-50` = 1 bila close besok > close hari ini), tapi `train_models.py:93-95` memakai `train_test_split(X, y, test_size=0.2, random_state=42)` — shuffle default pada deret waktu, tanpa `TimeSeriesSplit`, tanpa purge/embargo — sementara `train_models.py:68` hanya membuang `Close`, sehingga `Open/High/Low` dan pita SMA/EMA/BB **dalam satuan harga mutlak** tetap jadi fitur. Baris test ke-t lalu duduk di sebelah baris train t±1 dengan level harga nyaris identik: pohonnya menghafal hari, bukan membaca pola. Itu cukup menjelaskan "akurasi" 67–78% yang diklaim di docs, padahal base-rate majority class CSV yang mereka commit sendiri 50,5–54,2%. Dua temuan lain membuat isinya tidak bisa dipakai bahkan sebagai inspirasi: kolom `news_*` **konstan di semua baris** (snapshot RSS hari eksekusi disiar-siarkan ke 1 270 baris historis; kolom terakhir `EURUSDX_enhanced_features.csv` = 0 di seluruh file, dan Volume Yahoo untuk FX memang 0 sehingga OBV juga konstan), dan `src/testing/backtester.py:94-112` — bagian yang menghasilkan angka profit — **tidak pernah memuat modelnya**: `simulate_prediction` menulis "For backtesting, we'll use a simple strategy / In reality, you'd use your trained model here" lalu menebak dengan aturan RSI<30/>70 + confidence 0,7, dieksekusi di close bar yang sama, tanpa fee/slippage/spread, long-only. Bukti hasil: tidak ada (tidak ada trade log, equity curve, atau `outputs/paper_portfolio.json`; satu-satunya "angka" adalah `+$12,58 di atas $10.000` di README). Nilai gunanya bagi kita justru sebagai kontrol negatif: tiga kesalahan repo itu (split acak pada data waktu, fitur non-stasioner, isi-signal-di-close-yang-sama) adalah persis tiga hal yang sudah dibersihkan `tools/walkforward.js` (expanding window, fold bergerak, dinilai dari fold terburuk), `costPips()`/`--cost-extra` (spread data + biaya eksplisit), dan `tools/signal_test.js` (detrend global, blok bootstrap). Tidak ada yang diadopsi, dan itu ditulis supaya tidak dievaluasi ulang enam bulan dari sekarang.

**1-11-2026 — scanner jalan juga waktu terminal mati.** `MT5` beberapa kali ditemukan sudah tidak menulis
`sniper_status.txt` (status basi 960 dtk, lalu 14 375 dtk), dan setiap kali itu scanner ikut diam: tidak ada
sinyal, tidak ada rencana, dan tidak ada cara membedakan "tidak ada peluang" dari "tidak ada harga".
`bridge/feed.js` menutup lubang itu dengan harga publik Binance (bookTicker 1 dtk + klines 1m untuk warm-up),
dan batasnya dibuat tegas: sumber cadangan **tidak pernah** memanggil `submit()` — rencananya dicatat sebagai
`counts.paper` lalu dibuang, `sniper_req.txt` tidak dibuat, `state.orders` tetap kosong, bahkan dengan
`autoArm=true`. Jendela ARM tetap butuh terminal karena `expertRank`/`guardDecide` memang membaca
`sniper_status.txt`, jadi ada dua lapis penolakan, bukan satu. Perilaku panel ikut diubah supaya tidak bohong:
baris scanner sekarang menyebut `harga segar (EA)` atau `harga BINANCE (EA offline • sinyal paper, order
terkunci)`, dan sumber dihitung saat itu juga, bukan dari tick terakhir. Dua detail yang membuat feed ini
bukan sekadar "harga lain": satuan poinnya 10^−digits broker (bukan `pip/100` — BTC kebetulan sama, EURUSD/XAUUSD
melenceng 10× dan seluruh audit biaya ikut salah), dan spread yang dilaporkan adalah `typSpread` broker di
sekitar mid Binance (konvensi `tools/fetch_klines.js`), bukan spread Binance yang akan membuat R4/`minCost`
optimistis palsu. Jujur tentang proksinya: yang layak adalah BTC/ETH; EURUSDT hari ini menyimpang ~1,3 % dari
FBS dan nyaris tidak bergerak, PAXGUSDT ~7× lebih tenang dari XAUUSD terminal — jadi untuk dua pair itu
feed cadangan cuma membuktikan "mesin masih hidup", bukan mengukur biaya. Tidak ada yang di-arm, `dryRun`
tetap `true`, `autoArm` tetap `false`. Regresi: `bridge_test` 91, `scanner_test` 70 (19 baru: §J satuan feed,
§K sinyal-without-terminal + dua kontrol), `bridge_http_test` 37 (3 baru: `priceSource` di `/status`),
`ui_smoke` 0 error, `ea_sim` 11 langkah. Live: bridge 8790 di-restart dengan feed menempel —
`priceSource=mt5` (terminal hidup) dan `feed.ready=true` di latar; uji terminal-mati dilakukan di folder
kosong (`/tmp/sniper-nomt5`) dan scanner tetap memindai BTCUSD/ETHUSD sampai stage WATCH.



45 hari bar 1 menit Binance (EURUSDT, PAXGUSDT/BTCUSDT/ETHUSDT), split 60/40, dua kali pencarian penuh:

- **Tidak ada satu pun konfigurasi yang expectancy-nya positif di TRAIN.** Pencarian tetap jalan sampai plateau karena yang diminta adalah "kalibrasi", tapi hasilnya negatif semua — jadi tidak ada yang layak dijual sebagai "strategy terkalibrasi".
- Puncak terbaik: `TF=15m score≥0.48 ER≥0.22 ATR/biaya≥2.4 persist=30s cd=15m SL=3.2× TP=1/2.2 mom/trend≥0.12 ceil=0.75` → **TRAIN n=352 avgR −0.009 PF 0.943**, lalu **TEST n=242 avgR −0.067 PF 0.667, maxDD 11.3R**. TRAIN yang nyimpul nol + TEST yang memburuk = kurva-fit, bukan edge. Putusan alat: ✘ TIDAK bertahan di TEST.
- Tren arah perbaikannya konsisten dan masuk akal: horizon makin panjang makin sedikit rugi (`BAR_MIN` 1m → 5m → 15m menaikkan avgR dari −0.148 → −0.138 → −0.066 → plateau −0.009), dan `BRK_CEIL` 0.88 → 0.75 (menolak entry di ujung range 15 bar) membantu lagi.
- Penyebabnya terukur, bukan misterius: pada bar 1 menit ATR hanya ±1,5–2× spread ritel, sehingga gerbang `ATR/biaya` nyaris tidak pernah lolos dengan benar dan setiap trade membayar biaya hampir sebesar edge-nya. Di 15 menit rasio itu membaik tapi selisihnya masih di bawah nol.
- Konsekuensinya: `engine.js` **tidak** diisi angka "hasil optimasi" palsu. Default `PARAMS.BAR_MIN` dipindah ke **15** karena itu titik paling sedikit rugi dan horizon panjang juga membuat gate lebih stabil (sinyal tidak berkedip), tapi `MODES` sengaja tidak di-retrace: mengulang ambang di data yang sama hanya memindahkan angka negatif ke kolom TEST.

Angka di atas adalah bukti *tidak* ada edge pada pasangan parameter ini, bukan bahan optimasi lebih lanjut. Kalau spread brokermu jauh lebih kecil dari `typSpread` (0.0–0.2 pip ECN), kalibrasi ulang — biaya adalah variabel yang paling menentukan di sini.


## Statistik per pasangan — winrate scanner, tanpa MT5

Panel "🏆 STATISTIK PER PASANGAN" menjawab satu pertanyaan: **dari rencana yang lolos scanner,
winrate tiap pair bagus atau jelek?** Angkanya dihitung oleh mesin yang sama dengan yang dipakai
live (`engine.js`), jadi tidak ada cabang kode evaluasi terpisah yang bisa berbeda pendapat.

Ada dua angka, dan keduanya sengaja dipisah:

| Tabel | Sumber | Arti |
|---|---|---|
| **REPLAY DATA UJI** | `node tools/pair_stats.js` → `stats/pair_stats.json` | engine dijalankan di atas tick historis lokal (`data/*_1m.csv`), semua pair × semua mode. Jendela tiap pair sepanjang datanya ada (45–365 hari, tertulis di baris sumber panel). Ini yang dipakai untuk menilai kualitas model. |
| **WINRATE PER JAM UTC** | kolom `hours` di berkas yang sama + ledger tab ini | 24 sel, dipecah dari **jam masuk sinyal** (bukan jam keluar), dijumlahkan lintas pair pada mode yang sedang dipilih. Menjawab "jam berapa scanner ini layak dipakai". |
| **CATATAN LIVE** | `stats/live_ledger.jsonl` (daemon) + `localStorage` tab ini (`fxSniper2`) | plan yang benar-benar terkunci lalu selesai. Yang dari daemon bertambah terus walau tab tertutup; yang dari tab mulai dari nol. Jangan dinilai sebelum sampelnya cukup. |

Vonis dihitung dari ambang yang sejak awal dipakai proyek ini (`backtest.js`, `walkforward.js`):

- **BAGUS** — ≥30 trade **dan** `avgR > 0` **dan** profit factor ≥ 1,1
- **MARGINAL** — `avgR > 0` tapi PF di bawah 1,1
- **JELEK** — `avgR ≤ 0` dan PF < 1
- **SAMPEL n/30** atau **TANPA DATA** — belum bisa dinilai. Pair yang belum diuji tetap tampil di
  tabel dengan alasannya; daftar yang diam-diam menyusut lebih menyesatkan daripada daftar kosong.

Per jam pakai ambang sendiri, **≥20 trade** (`HOUR_MIN` di `app.js`), karena satu jam cuma
menampung ±1/24 sampel — syarat 30 trade per pair tidak akan pernah tercapai dan seluruh tabel
akan berbunyi "tipis". Yang dinilai per jam hanya `avgR` dan PF; **maxDD tidak dihitung** — drawdown
maksimum atas pecahan 1/24 data bukan ukuran yang berarti. Jam dengan `n < 20` berlabel *tipis* dan
sengaja tidak diberi vonis, jam tanpa trade ditulis `0 trade` supaya tidak terbaca sebagai 0%.

Berkas JSON menyimpan jam sebagai `{n, w, g, l}` (jumlah, menang, R untung kotor, R rugi kotor);
`avgR=(g-l)/n` dan `PF=g/l` diturunkan di browser. Ambang vonis karena itu bisa diubah tanpa
mengulang replay 20 menit.

Cara membuat datanya (sekali, ±20 menit untuk semua mode; satu mode ±3 menit):

```bash
node tools/pair_stats.js                       # semua pair × semua mode → stats/pair_stats.json
node tools/pair_stats.js --modes balanced       # cepat, satu mode saja
node tools/pair_stats.js --evalms 500           # evaluasi lebih sering (lebih lama, lebih halus)
```

Yang diuji hanyalah pair yang punya berkas tick lokal: **EUR/USD, XAU/USD (PAXG), BTC/USD, ETH/USD** —
empat dari sepuluh. Sisanya (USD/JPY, GBP/USD, USD/CHF, AUD/USD, USD/CAD, NZD/USD) tidak punya sumber
data publik di mesin ini, jadi kolomnya berbunyi "tidak ada sumber data lokal", **bukan** "0 trade".
Binance tidak lagi menyediakan feed FX untuk pair-pair itu; satu-satunya jalan adalah merekam tick dari
tombol **Export ticks** di panel, lalu menaruhnya sebagai `data/<SYMBOL>_1m.csv`.

Hasil replay terkini pada mode `balanced` (angka nyata, bukan ilustrasi — spread retail sudah dihitung,
slippage dan komisi belum):

| Pair | Jendela | n | Winrate | avgR | Total R | PF | Vonis |
|---|---|---|---|---|---|---|---|
| XAU/USD | 365 hari | 124 | 46,8% | +0,026 | +3,28 | 1,18 | BAGUS (tipis) |
| BTC/USD | 365 hari | 393 | 41,5% | −0,033 | −13,16 | 0,79 | JELEK |
| ETH/USD | 45 hari | 39 | 41,0% | −0,011 | −0,42 | 0,91 | JELEK |
| EUR/USD | 45 hari | 1 | 0% | −0,042 | −0,04 | 0,00 | SAMPEL 1/30 |

Mode lain tidak lebih baik: satu-satunya sel dengan PF > 1 selain `balanced`/`liquidity` di XAU/USD
adalah `auto` (n=19, PF 2,01) dan `edge` (n=5) — dua-duanya di bawah ambang sampel.

Yang penting dari tabel di atas bukan labelnya, tapi komposisinya: mayoritas penutupan adalah `TIME`
(time-stop 60 menit habis), bukan SL atau TP2 — 114/124 di emas, 356/393 di BTC. Artinya plan yang
terkunci biasanya **tidak bergerak ke mana-mana** — sinyal dapat arah tapi tidak dapat momentum, dan
"winrate" yang ada sebagian besar adalah "kena time-stop dalam posisi untung kecil". Untuk EUR/USD
cuma satu plan dalam 45 hari, sehingga semua angka "winrate" pair itu selama ini adalah satu kejadian.

## Daemon pengumpul data 24/7 — `tools/collector.js`

Selama ini catatan live hanya ada selama tab terbuka: ledger-nya `localStorage`, jadi ia ikut
hilang saat laptop tidur dan tidak pernah terlihat di GitHub Pages. `collector.js` memindahkan
pengumpulan ke Node: satu proses, satu WebSocket ke feed yang sama, engine yang sama
(`engine.js`), dan hasilnya ditulis ke berkas yang bisa dibaca panel.

**Tidak ada dependency.** Node ≥ 22 sudah punya `WebSocket` dan `fetch` global — tidak ada
`package.json`, tidak ada `npm install`.

```bash
node tools/collector.js                                  # feed deriv, semua pair, mode balanced
node tools/collector.js --pairs=XAUUSD,BTCUSD --modes=balanced,liquidity
mkdir -p logs && nohup node tools/collector.js >> logs/collector.log 2>&1 &   # tinggal jalan setelah shell ditutup
node tools/collector.js --replay=data/ETHUSDT_1m.csv --pairs=ETHUSD   # uji 1 jam, tanpa jaringan
```

Semua argumen diterima dalam dua bentuk (`--pairs=X` atau `--pairs X`). Yang ditulis dua berkas:

| Berkas | Isi |
|---|---|
| `stats/live_ledger.jsonl` | satu baris JSON per plan yang **selesai** — `id, pair, mode, feed, t, closedAt, side, done, resultR, mfe, mae, entry, sl, tp1, tp2, spread`. Append-only, tidak pernah ditulis ulang. |
| `stats/live_stats.json` | ringkasan (+ counter detak jantung: tick, plan, reconnect, error, umur tick terakhir). Ditulis atomik lewat `.tmp` + `rename`, jadi panel tidak pernah membaca separuh berkas. |

Yang dibaca panel adalah **ledger-nya, bukan ringkasannya**: ringkasan tidak bisa digabung
(maxDD, PF, dan Sharpe dari dua ringkasan bukan rata-rata yang sah), sedangkan baris mentah bisa
dihitung ulang dengan `E.summarize` yang sama seperti menghitung ledger tab. Karena itu panel
menyebut sumbernya terpisah — "2 plan dari daemon 24/7 + 1 plan dari tab ini" — dan dedup lewat
`id` plan (`pair|waktu|sisi`), bukan lewat angka.

Perilaku yang penting untuk proses yang ditinggal tidur:

- **Sambung ulang dengan backoff** 500 ms → 15 dtk (sama seperti `openWS` di `app.js`), plus
  watchdog: tidak ada pesan apa pun selama 60 dtk dianggap sambungan mati diam → putuskan dan
  sambung ulang. Konektor yang "hidup" tapi tidak mengirim apa-apa adalah kegagalan yang paling
  sering terjadi dan paling tidak kelihatan.
- **Pasar tutup bukan error.** `MarketIsClosed` dicatat sekali per kode (dengan pengali ×N), tidak
  menaikkan `counters.errors` — kalau tidak, satu akhir pekan akan terbaca sebagai 480 kegagalan
  padahal daemon-nya sehat dan tinggal menunggu.
- **Dedup sejak awal:** baris yang sudah ada di ledger dibaca dulu, jadi run kedua atas data yang
  sama tidak mencatat plan dua kali (`--replay` menulis ke `*.replay.*` supaya tidak pernah
  menyentuh ledger live).
- **`SIGINT`/`SIGTERM` = flush lalu keluar** — plan terakhir sempat ditulis, ringkasan sempat diperbarui.
- Exception tunggal tidak mematikan daemon (dijaga `uncaughtException`), tapi lebih dari 30 dalam
  satu menit dianggap hot loop dan prosesnya keluar supaya kelihatan di log.
- Detak jantung tiap 5 menit satu baris: tick, wsMsg, plan, uptime, umur tick terakhir.

`stats/live_stats.json` hanya dipakai panel untuk satu hal: **apakah daemon-nya masih hidup.**
Ringkasan yang umurnya lewat 10 menit tidak lagi disebut "aktif" — panel menulis kapan terakhir
berkas itu ditulis dan bilang angkanya tidak akan bertambah. Ini penting karena Pages menyajikan
berkas apa adanya: ledger kemarin sore akan tampil rapi seolah-olah live.

## 24/7 tanpa laptop: GitHub Actions (`collector.yml`)

Pages hanya menyajikan berkas, jadi collector harus jalan di suatu tempat. Workflow
`.github/workflows/collector.yml` menjalankan collector **di Actions itu sendiri** dan
menulis hasilnya kembali ke branch dengan `GITHUB_TOKEN` bawaan — tidak ada token pribadi
yang perlu dibuat, disimpan, atau ditempel di mana pun. Repo ini publik, jadi menit Actions
tidak dipungut biaya.

Bentuknya penting: **satu job hidup berjam-jam, dipecah jadi segmen 30 menit**, bukan
"collector 13 menit tiap 15 menit". `PLAN_TTL` engine ini 60 menit, jadi window pendek akan
membuang hampir semua plan yang belum selesai dan menyisakan hanya plan yang kena SL/TP cepat
— itu bukan sampel kecil, itu sampel yang berat sebelah, dan winrate yang dihitung darinya
menyesatkan. Cron `*/15` di workflow itu hanyalah penunjuk jalan: `concurrency.group: collector`
memastikan hanya ada satu instance, dan begitu yang lama keluar, jadwal berikutnya langsung masuk.

Perjalanan tiap segmen: `timeout -s TERM --preserve-status` → collector flush lalu keluar 0
→ `tools/publish.sh` commit + push `stats/live_ledger.jsonl` dan `stats/live_stats.json`.
`--preserve-status` wajib: tanpa itu `timeout` selalu mengembalikan 124 untuk segmen yang
berakhir sesuai rencana dan setiap segmen terbaca seperti kegagalan.

Dua hal yang harus disentuh sekali di GitHub (tidak bisa dari repo):

1. **Settings → Actions → General → Workflow permissions → "Read and write permissions"**.
   Default banyak repo adalah read-only, dan publish akan gagal `403` dengan pesan yang tidak
   jelas. Ini penyebab paling mungkin kalau workflow-nya hijau tapi halaman tidak pernah berubah.
2. Jalankan sekali lewat **Actions → collector 24/7 → Run workflow** dengan `hours: 1` sebelum
   percaya pada jadwal. Lihat log-nya: kalau `counters.ticks` masih 0 setelah satu segmen,
   feed Deriv tidak mau diajak bicara dari IP datacenter — jalankan ulang dengan `feed: binance`
   dan `pairs: BTCUSD,ETHUSD` (jalur itu teruji di mesin ini: 1781 tick dalam 25 detik).

Yang jujur soal batasnya:

- GitHub tidak menjanjikan ketepatan cron; saat antrian padat, jadwal bisa molor beberapa menit,
  dan **schedule otomatis dimatikan di repo yang 60 hari tidak ada perubahan**. Workflow ini
  menulis commit tiap 30 menit, jadi selama ia hidup repo-nya tetap "aktif" — tapi kalau ia
  dimatikan manual, tidak ada yang menyalakannya kembali.
- Batas keras Actions adalah 6 jam per job (`timeout-minutes: 340` di sini, berhenti sendiri
  di 5 jam supaya sisa waktunya cukup untuk publish). Ini bukan hosting; kalau GitHub suatu hari
  membatasi job panjang, jalan keluarnya tetap sama tetapi di mesin lain (VPS/Raspberry Pi,
  `systemd` + `tools/publish.sh` — skrip publish-nya tidak peduli siapa yang memanggilnya).
- Push bisa gagal 3 kali percobaan (branch bergerak, konflik). Yang hilang cuma satu segmen;
  ledger tetap append-only dan segmen berikutnya mencoba lagi.

Cara melihatnya dari luar:

```bash
git ls-remote origin main                                   # commit "stats: collector ..." harus terus baru
curl -s https://qhusipitoyo-debug.github.io/SniperFXBTCETHXAU/stats/live_stats.json | head -c 200
```

## Publikasi: GitHub Pages, tanpa Jekyll

Panel ini sudah statis murni — satu `index.html`, `app.js`, `engine.js`, `styles.css`, dan satu berkas
data. Tidak ada langkah build, jadi **Jekyll tidak diperlukan dan justru sebaiknya dimatikan**
(Pages → *Deploy from a branch* → `main` / `root`). Jekyll akan menjalankan Liquid di atas HTML,
melewati berkas berawalan `_`, dan menambah 30–60 detik build tanpa manfaat.

Yang perlu diketahui supaya versi online berperilaku sama dengan versi localhost:

1. **`stats/pair_stats.json` ikut di-commit** (±22 KB), berbeda dari `data/` yang di-ignore. Alasannya:
   panel membaca berkas itu lewat `fetch`, dan browser di GitHub Pages tidak bisa menjalankan
   `tools/pair_stats.js`. Berkas ini satu-satunya "build artifact" yang sengaja versioned — kalau
   datanya basi, regenerate lalu commit ulang.
2. **Feed live jalan dari https** karena semuanya `wss://` (`api.derivws.com`, `stream.binance.com`,
   `data-stream.binance.vision`) dan REST-nya `https://`. Hanya `?proxy=ws://127.0.0.1:8787` yang mati
   di Pages — itu jalur proxy lokal opsional, bukan default.
3. **Semua path relatif**, jadi repo yang tayang di `https://<user>.github.io/<repo>/` tidak perlu
   konfigurasi apa pun. Jangan menambah `baseurl`/Jekyll config.
4. **`bridge/`, `mt5/`, dan alat uji MT5 tidak ikut ke repo** (lihat `.gitignore`). Yang tayang hanya
   jalur analisis; `README.md` di bawah ini masih memuat bagian auto-order sebagai catatan historis.
5. **Yang tayang adalah berkas hasil, bukan prosesnya.** GitHub Pages menjalankan apa pun di browser
   tetapi tidak menjalankan Node, jadi daemon 24/7 harus hidup di mesin lain — lihat bagian
   *24/7 tanpa laptop* di atas untuk opsi Actions, atau jalankan `collector.js` di laptop/VPS sendiri.
   Output-nya kemudian di-commit seperti `pair_stats.json` — `stats/live_ledger.jsonl` dan
   `stats/live_stats.json` sengaja **tidak** di-ignore karena itulah yang membuat CATATAN LIVE dan
   winrate per jam bertambah walau tidak ada tab yang terbuka. Halaman yang di-host akan selalu
   menampilkan ledger sampai commit terakhir, bukan detik ini; panel menyebut waktu tulis ringkasan
   supaya selisihnya kelihatan, bukan tersamar.

```bash
node tools/pair_stats.js && git add stats/pair_stats.json && git commit -m "stats: replay terbaru"
node tools/collector.js --replay=data/BTCUSDT_1m.csv --pairs=BTCUSD   # uji tanpa jaringan dulu
git add stats/live_ledger.jsonl stats/live_stats.json && git commit -m "stats: ledger daemon"
git push                                                    # Pages: Settings → Pages → Deploy from branch
```

## Auto-order MT5 (DEMO saja) — v8 — **DIHAPUS**

> **Koridor ini sudah tidak ada.** MT5 auto-order tidak bisa jalan di mesin ini (terminal tidak
> menulis status EA, dan guard memblokir order), jadi seluruh komponennya dilepas dari panel:
> section AUTO-ORDER, tombol ARM, bridge/`/status`, pembacaan `sniper_status.txt` dan
> `sniper_trades.txt`, serta kolom offset harga terminal. Panel sekarang murni analisis lokal.
> Kode `bridge/` dan `mt5/SniperBridge.mq5` masih ada di repo sebagai rujukan, tetapi **tidak**
> lagi dijalankan `tools/autostart.sh` dan tidak ada satu pun baris `app.js` yang menyentuhnya.
> Dokumentasi di bawah ini dibiarkan sebagai catatan historis; jangan diikuti.

**Baca dulu.** Mesin sinyal ini tidak punya edge yang terukur (TEST −0.067 R/trade, PF 0.667). Auto-order tidak mengubah itu; yang diubah hanyalah *siapa* yang menekan tombol. Karena itu jalur ini dibangun sebagai **mesin rugi yang dibatasi**, bukan mesin profit: semuanya default mati, default DRY RUN, dan berhenti sendiri kalau menyentuh plafon. Yang dikejar di sini adalah "saldo tidak minus dan sistem berhenti sebelum rusak", bukan "+$25 apa pun yang terjadi" — mengejar target dengan memperbesar lot adalah martingale dan tidak diimplementasikan.

### Alur

```
browser (app.js, panel AUTO)  --HTTP 127.0.0.1:8790-->  bridge/server.js  --file MQL5/Files-->  SniperBridge.mq5  -->  MT5 (Wine/Bottles)
```

Kenapa lewat file, bukan Python `MetaTrader5`: modul itu Windows-only dan terminal jalan di Wine, jadi tidak ada jalur COM. Folder `MQL5/Files` bisa dibaca-tulis langsung dari Linux tanpa konfigurasi terminal apa pun. Bridge memutuskan *pair mana yang layak* + guard harian; EA memutuskan *order jadi atau tidak* terhadap akun nyata. Dua-duanya punya guard sendiri — yang satu tidak bisa menembus yang lain.

### Yang hanya bisa kamu lakukan (2 hal)

1. **Pasang MT5 di bottle lalu login akun DEMO FBS.** Tidak ada build FBS di bottle mana pun sekarang; unduh `mt5setup.exe` dari FBS dan install ke bottle tempat terminal lain sudah ada. Akun **demo** — EA menolak akun real kecuali `InAllowLive=true` diubah sadar-sadar.
2. **Biarkan mesin menyala.** Bridge + EA jalan selama terminal terbuka dengan EA terpasang di chart dan **Algo Trading** aktif.

### Pasang EA

```bash
bash tools/compile_ea.sh              # deteksi bottle + terminal, salin .mq5, compile headless, cek log
BOTTLE=~/.var/app/com.usebottles.bottles/data/bottles/bottles/FBS bash tools/compile_ea.sh   # bottle lain (mis. tempat FBS dipasang)
```

Skrip keluar non-zero kalau ada error/warning. Hasil terverifikasi: `Result: 0 errors, 0 warnings … OK -> …/MQL5/Experts/SniperBridge.ex5`. **Compile ulang tidak me-reload chart** — terminal tetap menjalankan `.ex5` yang lama sampai EA-nya dilepas dan dragged ulang (ini ketahuan saat uji pertama: penolakan datang dari guard build lama). Cara memastikan: `GET /status` → `ea.build` = waktu compile build yang jalan; `unknown` berarti masih binary lama. (`build` dulu cuma tanggal — `TimeToString(__DATE__)` selalu jadi `00:00` — jadi dua compile dalam satu hari tidak terbedakan; sekarang `__DATETIME__` ikut jamnya.) Setelah compile, buka terminal → Navigator → Expert Advisors → **SniperBridge** → seret ke chart salah satu pair di `InSymbols` → aktifkan Algo Trading. Input penting: `InRiskPct=1.0`, `InMaxLot=0.10`, `InMaxPositions=2`, `InMaxTotalRiskUsd=20`, `InMaxDailyLossUsd=10`, `InProfitTargetUsd=25`, `InMinEquityUsd=0`, `InSlippagePoints=10`, `InStatsDays=30`, `InStatsMax=300` (jendela `sniper_trades.txt` untuk panel statistik).

### Clone dari GitHub → jalan sendiri di localhost

```bash
git clone https://github.com/<user>/<repo>.git && cd <repo>
node tools/fetch_klines.js BTCUSDT ETHUSDT EURUSDT PAXGUSDT --days=30   # data/ di-.gitignore (31 MB), wajib sebelum kalibrasi/test
cp bridge/config.example.json bridge/config.json                        # opsional; lihat catatan di bawah
python3 -m http.server 8080                                             # panel: http://localhost:8080
node bridge/server.js                                                   # DRY RUN, filesDir auto-discover
```

Empat hal yang harus diketahui orang yang baru clone:

1. **`bridge/config.json` dan `bridge/state.json` sengaja tidak masuk repo.** Yang pertama berisi `filesDir` milik mesin penulis (path bottle/terminal), yang kedua riwayat order + ack lokal. Tanpa `config.json` bridge memakai `DEFAULTS` di `server.js` — dan itu **DRY RUN + `autoArm=false`**, jadi clone baru tidak mungkin mengirim order sampai kamu menyalakan sendiri (`POST /arm {"dryRun":false}`). `config.example.json` adalah salinan DEFAULTS itu, bukan konfigurasi mesin ini.
2. **`data/*.csv` juga tidak masuk repo** (31 MB, bisa diunduh ulang). Tanpa berkas itu, `tools/calibrate.js`, `tools/latch_test.js`, `tools/scanner_test.js` dan `tools/bridge_test.js` tidak bisa jalan — unduh dulu dengan `fetch_klines.js`.
3. **Panel butuh terminal MT5 yang sedang jalan**, bukan cuma Node. Baris `python3 -m http.server` + `node bridge/server.js` saja hanya memberi feed Binance di tab analisa; order menuntut EA terpasang di chart (bagian *Pasang EA*) dan `ea.build` menunjuk jam compile terakhir.
4. **Bagian `proxy/` di awal README tidak berlaku untuk clone ini** — folder itu tidak ada di repo; jalur harga yang dipakai adalah terminal MT5 lewat bridge (satu sumber harga, lihat *Scanner otonom*).

### Jalankan bridge

```bash
node bridge/server.js                 # DRY RUN, port 8790, filesDir auto-discover
node bridge/server.js --broker fbs    # lebih dari satu terminal: paksa folder broker ini
node tools/bridge_test.js             # 91 assertion: guard, pakar R1–R9, submit, perintah kontrol, sesi libur, statistik
node tools/bridge_http_test.js        # 34 assertion: rute HTTP + format berkas KV + scanner/ARM (semua di dir sementara)
node tools/scanner_test.js            # 51 assertion: rantai scanner otonom direplay dari data nyata
node tools/ea_sim.js                  # 11 langkah: plan→order→ack bolak-balik, EA disimulasikan, tanpa terminal
node tools/order_test.js BTCUSD       # SATU order uji nyata ke terminal demo yang sedang jalan (pakar harus bilang LAYAK dulu)
curl -s 127.0.0.1:8790/status | head -c 400
```

Flag: `--live` (matikan dry run), `--dry`, `--arm` (scanner boleh mengirim order tanpa browser), `--no-scan` (matikan loop sinyal), `--files=<path MQL5/Files>`, `--broker=<nama>`, `--port=`, `--target=`, `--maxloss=`, `--risk=`. Berkas `bridge/config.json` dan `bridge/state.json` dibuat saat run pertama; uji otomatis hanya menulis ke temp, repo tetap bersih. Kalau `filesDir` tidak diisi dan ada **beberapa** terminal MetaTrader 5, bridge tidak lagi asal ambil yang pertama: ia pilih terminal yang `sniper_status.txt`-nya paling baru ditulis (jam melenceng >5 menit tidak dihitung "hidup"), dan mencetak semua kandidat supaya salah terminal kelihatan, bukan diam-diam.

Endpoint: `GET /status` (bridge, ea, guard, ranking, orders, hist, **stats**, **scanner**, local, acks), `GET /ranking`, `POST /signal|/update|/halt|/resume|/config|/arm|/disarm`.

### Panel statistik — winrate, pair apa yang diorder, profit dan loss

Panel **AUTO-ORDER** punya blok "STATISTIK ORDER NYATA". Angkanya diambil dari **deal penutupan di terminal** (`sniper_trades.txt`, ditulis ulang oleh `WriteTrades()` di EA setiap ada posisi selesai), bukan dari tebakan browser — jadi yang muncul adalah realisasi broker: `profit + swap + komisi`.

| Blok | Isi |
|---|---|
| WINRATE | menang / kalah / datar. Trade datar (usd = 0) **tidak** masuk penyebut, supaya 1 menang + 1 kalah + 1 datar tidak dibaca 33% |
| BERSIH | net USD, jumlah untung kotor dan jumlah rugi kotor |
| PROFIT FACTOR | grossWin / grossLoss. `—` + keterangan "belum ada rugi" kalau `null` tapi pernah menang |
| HARI INI | realisasi sejak tengah malam UTC (jam broker dikoreksi ke GMT lewat `TzOffset()`, jadi "hari" di EA dan di bridge artinya sama) + floating posisi yang masih terbuka |
| PER MARKET | **semua pair yang dipindai**, bukan hanya yang sudah ditutup. Yang ada datanya: winrate, jumlah trade, rata-rata $/trade, net $ — **dan** percobaan order dari bridge: `dipesan N • diterima N • ditolak N • dry N`, urut bersih terbesar dan tampil lebih dulu. Yang belum: `0 ditutup • <alasan hari ini>` dari ranking pakar (R2 sesi / R4 biaya / R5 saldo, atau "layak hari ini — belum ada yang dipesan"). Pair dengan symbol broker berbeda (`BTCUSD.a`) dikelompokkan ke pair scanner lewat `symbolMap`, symbol asing tetap tampil apa adanya |
| ALASAN PENUTUPAN | per `why`: `TP`, `SL`, `EA` (time-stop / partial TP1 / CLOSEALL), `MANUAL`, `STOP-OUT`. Di sinilah kelihatan apakah rugi datang dari pasar atau dari sistem yang menutup terlalu dini |
| PENUTUPAN TERAKHIR | 12 deal terbaru, Terbaru lebih dulu |
| MASIH BERJALAN | posisi terbuka + PnL floating + ticket — belum untung, belum rugi, jangan dihitung sebagai menang |

Jujur soal ukurannya: di bawah `minSample` (=20) panel menempelkan peringatan kuning "winrate ini belum berarti apa-apa". Satu dua trade bukan bukti, dan kalibrasi offline pun tidak menunjukkan edge terukur, jadi panel ini alat pantau — bukan janji. Kalau nanti `SL` dan `EA` menumpuk sambil `TP` nyaris nol, yang harus diubah adalah gerbang scanner (R4 biaya, `minCost`) atau geometri `InBeAtR`/`InMaxHoldMin`, bukan risikonya.

Kalau `stats.available === false`, artinya build EA di chart masih yang lama (belum pernah menulis `sniper_trades.txt` sama sekali) — compile ulang lalu **load ulang EA-nya**. Build baru menulis berkasnya sejak langkah pertama walaupun isinya kosong, dan berkas kosong dibaca bridge sebagai "statistik tersedia, 0 trade", bukan "build lama".

### ARM di browser

Panel **AUTO-ORDER** paling bawah: isi saldo & risiko seperti biasa, centang/uncentang DRY RUN, lalu **ARM AUTO (2 klik)** — klik pertama menyiapkan, klik kedua dalam ≤5 detik mengaktifkan. Tombol ARM **nonaktif** sampai EA melaporkan `mode=demo` dan Algo/expert Trading diizinkan, jadi tidak ada jalan arm ke akun real dari UI. Setelah arm, setiap rencana yang terkunci (ENTRY) dikirim satu kali (`AUTO.sent[pair]` dicegah dobel) dan hasil penutupan posisi dilaporkan balik lewat `/update`.

Tombol darurat memakai protokol file yang sama, jadi perintahnya tetap jalan walaupun browser/bridge mati setelah perintah ditulis: **STOP** mengirim `cmd=HALT` (EA berhenti membuka posisi baru, posisi yang sudah ada tetap dikelola BE/TP1/time-stop), **RESET HARIAN** mengirim `cmd=RESUME` (membuka halt non-permanen di EA dan menyetel ulang cap/cooldown di bridge), **TUTUP SEMUA POSISI EA** mengirim `cmd=CLOSEALL` — hanya posisi dengan magic EA yang ditutup, posisi manual kamu tidak disentuh. Tiap perintah kontrol dapat id dari antrean yang sama, dan id tidak pernah ≤ `lastid` yang dilaporkan EA (kalau `bridge/state.json` dihapus, order tidak hilang diam-diam karena dianggap duplikat).

### Scanner otonom — mesin sinyal pindah ke Node, tab browser tidak lagi wajib

Sebelum bagian ini, "auto" selalu berarti **ada tab browser terbuka**: `app.js` yang menjalankan
`engine.js`, mengunci rencana, lalu POST `/signal`. Tutup tab atau tidur laptop dengan tab tertutup
= tidak ada order baru (posisi yang sudah terbuka tetap dikelola EA, karena time-stop/BE/TP1 ada di
terminal). Sekarang `bridge/scanner.js` menjalankan loop yang sama di dalam proses bridge:

```
sniper_status.txt  -> tick broker tiap detik  (bid/ask/ATR per simbol, jam broker)
sniper_bars.txt    -> 270 bar 1 menit dari terminal (warm-up instan, bukan 4 jam nunggu tick)
        ↓ engine.js (mode scanMode: balanced)
rencana terkunci   -> rt.submit()  -> guard harian + pakar R1–R9  -> sniper_req.txt -> EA
```

Satu sumber harga, dan itu pilihan sadar bukan kebetulan: order `id=1000003` dulu ditolak EA dengan
`harga sudah lari 300.0 pts` karena browser memakai harga Binance sementara eksekusi memakai harga
FBS. Scanner sekarang menghitung `entry` dari bid/ask **yang sama** dengan yang dibaca EA sedetik
kemudian, jadi guard drift tidak punya alasan (di `tools/scanner_test.js` drift terukur ≤ 100 points,
biasanya 0 karena `entry = ask` untuk BUY dan `bid` untuk SELL).

Yang **tidak** berubah: keputusan order tetap lewat `submit()` — guard watchdog/cap +$25/batas rugi
−$10/equity floor/cooldown/HALT dan sistem pakar R1–R9, lalu guard kedua di EA (demo-only, stops
level, drift, spread, lot). Yang berpindah hanya *siapa yang memanggil* `submit()`.

```bash
node bridge/server.js --dry --arm        # scanner jalan + boleh mengirim, tapi dry run
node bridge/server.js --no-scan          # loop sinyal dimatikan (hanya endpoint)
curl -s -X POST 127.0.0.1:8790/arm       # autoArm=true, tersimpan di bridge/config.json
curl -s -X POST 127.0.0.1:8790/disarm    # mati lagi; scanner tetap jalan, rencana hanya dicatat
curl -s 127.0.0.1:8790/status | jq .scanner   # pairs, warm per pair, counts, lastPlan, lastResult, err

# supaya scanner tidak ikut mati saat shell/sesi penyalanya ditutup (atau pakai tools/autostart.sh):
setsid nohup node bridge/server.js --live --arm > /tmp/sniper_bridge.log 2>&1 < /dev/null &
```

`autoArm` **default mati** bahkan ketika scanner jalan — menyalakan `--arm`/`POST /arm` adalah satu-satunya
jalan mesin boleh memesan, dan panel menampilkan statusnya di baris "AUTO OTONOM" + tombol
**ARM SCANNER (2 klik)** (tombol lama "ARM AUTO" tetap ada: itu arm untuk scanner di browser). Bridge yang
di-arm tetap tidak bisa menyentuh akun real: EA menolak `trade_mode != demo` kecuali `InAllowLive` diubah
sengaja, dan guard bridge menolak akun non-demo/contest.

Sisi pengukurannya: `tools/scanner_test.js` mereplay `data/BTCUSDT_1m.csv` (64.800 menit, barisnya
berjarak 15 detik — bukan 1 menit, jadi seri mentah diagregasi ke bar 1 menit lebih dulu; langkah replay
5 detik karena `DT_CAP` engine 6 detik) dan menguji rantaianya, bukan angkanya: tanpa `sniper_bars.txt`
scanner diam dan bilang berkasnya hilang; dengan `autoArm=false` rencana terkunci tapi `sniper_req.txt`
tidak pernah dibuat; dengan `autoArm=true` order dihitung, diterima pakar, dan baris `cmd=BUY;volume=0;
riskusd=…` ditulis; status EA basi (`now − ts > watchdog`) membuat `tick()` menolak dan tidak menulis
apa pun. Satu hal yang sempat salah di test ini dan perlu diingat: `mkt1` harus membawa **ATR(14) M15**
seperti yang dilaporkan EA (`InAtrTF = PERIOD_M15`), bukan rentang 1 menit — dengan ATR 1 menit R4
menolak semua rencana dengan alasan biaya (1,88 < 2,4) yang sebenarnya palsu.

#### Dua sumber harga — terminal hidup pakai EA, terminal mati pakai Binance (sinyal jalan terus, order tidak)

Kegagalan yang paling sering terjadi pada mesin ini bukan sinyal dan bukan guard: `sniper_status.txt`
berhenti diperbarui karena terminal Wine mati atau EA lepas dari chart. Sampai hari itu konsekuensinya
scanner ikut berhenti — `tick()` keluar dengan "status EA basi" dan tidak ada satu pun rencana lahir,
padahal pertanyaan yang ingin dijawab operator ("apakah sistem masih melihat peluang?") tidak butuh
broker. Sejak `bridge/feed.js` ada, loop tetap jalan dengan harga publik Binance, dan yang berhenti
hanya sisi eksekusinya.

```
sniper_status.txt segar  -> sumber "mt5"     -> fire -> eaSpreadCap -> rt.submit() -> sniper_req.txt
tidak ada / basi         -> bridge/feed.js   -> fire -> catatan PAPER, submit() tidak pernah dipanggil
```

Aturannya satu: **order hanya boleh lahir dari harga yang juga dipakai terminal memeriksa drift** — itu
alasan scanner ini ada, jadi feed cadangan tidak boleh mewarisinya. Selama `priceSource != "mt5"`,
`fire()` mengirim rencana ke `note('paper')`, menaikkan `counts.paper`, lalu `release(plan,false)`
(buang rencananya, cooldown mesin tetap jalan) — `sniper_req.txt` tidak pernah dibuat dan
`state.orders` tetap kosong, bahkan dengan `autoArm=true`. Guard sendiri juga masih menutup jalur itu
dari sisi lain: `expertRank`/`guardDecide` membaca `sniper_status.txt`, jadi `submit()` akan berbunyi
"pair tidak ada di Market Watch EA" / watchdog kalau ada yang memaksa.

Cara feed meniru `mkt1` (dan di sinilah dua kekeliruan satuan ditemukan):

* **Satuan poin = 10^−digits broker** (`pointsPerPip`/`brokerPoint` di `server.js`), bukan `pip/100`.
  BTC kebetulan sama (pip 1, dp 2 ⇒ 100), jadi `pip/100` lolos uji BTC dan meleset 10× di EURUSD/XAUUSD
  (dp 5 dan 2 ⇒ 10 poin per pip). Sekarang `quoteOf`/`atr15Of` diuji langsung terhadap angka yang
  ditulis EA: EURUSD 28, XAUUSD 45, BTCUSD 2000, ETHUSD 200 points.
* **Spread yang dipakai = `typSpread` broker** ditata simetris di sekitar mid Binance (konvensi yang sama
  dengan `tools/fetch_klines.js`), karena spread Binance (±0,01 %) bukan biaya yang akan dibayar di akun
  FBS (BTC ±$20); memakainya akan membuat audit biaya R4/`minCost`/pagar EA optimistis palsu. Untuk spread
  ganjil (XAUUSD 45 poin) sisinya 23/22 — mid kutipan bergeser setengah tick, dan engine hanya membaca
  `(ask+bid)/2`.
* **ATR(14) pada bar 15 menit**, emberan terakhir yang masih berjalan dibuang — sama seperti
  `InAtrTF = PERIOD_M15`.

Yang harus diketahui jujur tentang proksinya: hanya 4 pair yang punya `binance` di `PAIRS`
(EURUSD→EURUSDT, XAUUSD→PAXGUSDT, BTCUSD/ETHUSD), dan proksinya tidak setara. Pada hari pengujian,
EURUSDT menyimpang ~1,3 % dari harga FBS dan rentang 15 menitnya hampir nol, PAXGUSDT bergerak ~7×
lebih tenang dari XAUUSD terminal (ATR M15 $0,98 vs $7,46). Artinya feed cadangan layak untuk
**BTC/ETH** (keduanya memang 24/7 dan tidak pernah ditutup), dan untuk XAU/EUR hanya sebagai
"mesin masih hidup", bukan sebagai angka biaya yang bisa dipercaya. `counts.paper` memisahkan sinyal
jenis ini dari sinyal yang benar-benar bisa dieksekusi, dan panel menyebut sumbernya:
`harga BINANCE (EA offline • sinyal paper, order terkunci)`.

`fallbackFeed` default **aktif**; matikan dengan `"fallbackFeed": false` di `bridge/config.json` atau
`node bridge/server.js --no-feed`. Harga cadangan bukan harga broker, jadi ia tidak pernah membuat
`tick()` mengaku segar: `pickSource()` memakai `watchdogMs` yang sama untuk kedua sumber.


`ranking` menjawab pertanyaan "pasangan mana yang boleh dibuka dengan saldo ini", aturan R1–R9, tiap penolakan punya string alasan (bukan sekadar hilang dari daftar):

| Aturan | Cek |
|---|---|
| R1 data | bid/ask/ATR dari status EA masih segar |
| R2 sesi | pair sedang di dalam sesi trading-nya |
| R3 spread | spread titik ≤ `maxSpreadPips` (default `PAIRS[pair].maxSpread`) |
| R4 biaya | ATR(pips) ≥ `minCost` × biaya(pips) — gerbang yang sama dengan engine |
| R5 saldo | **lot minimum masih muat** dengan risiko `riskPct` × ekuitas; kalau tidak, pair ditolak dengan alasan "saldo tidak cukup" |
| R6 margin | margin pada volume yang diminta ≤ sebagian margin free (leverage dari status EA) |
| R7 riwayat | pair dibekukan kalau cukup sample (`minSample`) dan hasil tercatat jelek |
| R8 tunggal | satu posisi per simbol; kalau sudah ada, tidak diantrikan lagi |
| R9 plafon | jumlah risiko terbuka + sisa ruang hari ini |

### Autostart — laptop dinyalakan, semua sudah jalan sendiri

`tools/autostart.sh` menyalakan urutan yang sama seperti manual, tanpa ada yang perlu diketik:
**MT5 (bottle Bottles) → tunggu status EA segar → bridge Node (scanner otonom) → panel localhost:8080**.
Satu entri `~/.config/autostart/sniperfx.desktop` memanggilnya setiap login; entri itu tidak ditulis
tangan, tapi dihasilkan skrip sendiri supaya jalurnya ikut benar di clone lain.

```bash
bash tools/autostart.sh --install    # daftarkan ke autostart login (sekali saja)
bash tools/autostart.sh              # mulai apa yang belum jalan
bash tools/autostart.sh --status     # MT5 / bridge / panel / umur sniper_status.txt
bash tools/autostart.sh --uninstall  # cabut lagi
```

Yang sengaja dibuat begitu:

* **Idempoten dan tidak pernah mematikan apa pun.** Yang sudah hidup dibiarkan, jadi aman dijalankan
  berulang. Bridge dan panel diukur dari **portnya** (`curl 127.0.0.1:8790`, `:8080`), bukan dari nama
  proses — `pgrep -f` gampang menjaring shell yang sedang menjalankan skripnya sendiri, dan satu-satunya
  hal yang memang harus dicari dari proses adalah terminal MT5 (wine mendaftarkannya sebagai comm `main`,
  jadi polanya `terminal64[.]exe` pada command line dengan PID sendiri dikecualikan).
* **MT5 diluncurkan di latar.** `bottles-cli run` kadang tidak mengembalikan kontrol sampai terminal
  tutup, jadi keberhasilannya diukur dari prosesnya yang muncul (`wait_mt5`), bukan exit code CLI;
  kalau program tersimpan `terminal64` gagal, ia mencoba path executable-nya sekali lagi.
* **State ARM tidak hilang.** Bridge hanya menyalakan `node bridge/server.js`; `dryRun` dan `autoArm`
  dibaca dari `bridge/config.json`, jadi setelah restart sistem tetap `LIVE-DEMO + ARM` seperti
  keadaan terakhir, tanpa perlu `--live --arm` diketik ulang.
* **Kegagalan bicara, bukan diam.** Kalau dalam 180 detik `sniper_status.txt` masih basi, skrip menulis
  `PERINGATAN` ke `~/.local/state/sniperfx/autostart.log` bahwa chart/Algo Trading belum pulih —
  itu kondisi yang hanya bisa kamu perbaiki dari terminal.

Membatalkan lagi: `bash tools/autostart.sh --uninstall` (sama dengan `rm ~/.config/autostart/sniperfx.desktop`).

Sudah diuji: dijalankan saat semuanya hidup (tidak ada duplikat, bridge lama tidak tersentuh,
status EA 0 detik), dan `env -i HOME=$HOME tools/autostart.sh --status` untuk meniru lingkungan login
yang minim — skrip menegaskan `PATH` dan `DISPLAY` sendiri karena autostart desktop tidak
membaca `.zshrc` dan tidak mewarisi environment shell. Entri yang dihasilkan `--install` lolos
`desktop-file-validate` dan menunjuk ke skrip di dalam projek, tidak ada berkas yang ditambal di luar repo. **Yang belum dan memang hanya bisa terlihat setelah restart sungguhan:** apakah
workspace MT5 mengembalikan chart dengan SniperBridge terpasang dan tombol **Algo Trading** masih
nyala (keduanya diatur terminal, bukan skrip ini), jadi cek `--status` sekali setelah restart pertama.

### Guard — supaya saldo tidak minus

Bridge menolak kirim sebelum menyentuh EA kalau: status EA tidak ada/basi (`watchdogMs` 20 s), akun bukan demo/contest, Algo Trading belum aktif, EA sedang HALT, halt manual, masih DRY RUN, realisasi hari ini ≥ `targetUsd` (+$25 = **cap, berhenti**, bukan dikejar), rugi harian ≤ −$10, ekuitas < `minEquityUsd` atau < `equityFloorPct` dari saldo awal hari, atau dalam cooldown. EA memeriksa ulang semuanya terhadap akun nyata **dan** memotong lot: `volume` dari bridge selalu 0, lot dihitung di EA lalu di-clamp ke `InRiskPct` dan ruang risiko tersisa — tidak pernah diperbesar. Tambahannya di EA: SL/TP wajib dan hormati `SYMBOL_TRADE_STOPS_LEVEL`, drift harga > `InMaxPriceDriftPts` ditolak, spread > `InMaxSpreadPoints` ditolak, margin > 80% margin free ditolak, BE di `InBeAtR`, partial close 50% di TP1 lalu SL ke entry, time-stop `InMaxHoldMin`, restart recovery (`sniper_pos.txt`/`sniper_lastid.txt`) supaya tidak ada order ganda.

### Uji jalur order tanpa terminal

`node tools/ea_sim.js` menjalankan bridge sungguhan di port 8791 dengan `filesDir` di `/tmp/sniper-e2e/files`, lalu **meniru sisi EA** dengan field yang sama persis seperti `WriteStatus()` di `SniperBridge.mq5` (`trade_mode=demo`, `mkt1=BTCUSD:spread:ask:bid:atr`, `pos1=…`, `lastid=…`), membaca `sniper_req.txt`, menjalankan guard versi EA (halt, satu posisi per simbol, spread, drift, `volume` harus 0, lot dari `riskusd`), dan membalas `sniper_ack.txt`. Hasilnya tercetak sebagai 11 langkah: ranking per saldo, order diterima → ticket masuk antrean, order kedua ditahan cooldown, EUR/USD ditolak R2 di akhir pekan, STOP/RESUME/TUTUP SEMUA sampai ke terminal, penolakan drift dari EA tercatat di order. Yang **tidak** diuji: `OrderSend` MetaTrader, spread/margin/filling nyata.

Panel UI menampilkan hasil balasan ini di baris **JAWABAN TERMINAL** (`BTCUSD BUY: diterima, ticket 900002` / `ETHUSD SELL: DITOLAK — spread 41 > 30 points` / `DRY RUN — perintah tidak ditulis ke terminal`), karena ack dibaca sekali lalu berkasnya dikosongkan — tanpa ditempel ke order, penolakan terminal hilang tanpa jejak. Sejak perbaikan ack→engine, yang membaca duluan tidak lagi harus panel: `tick()` scanner menguras `sniper_ack.txt` sendiri dan menyalin jawabannya ke `state.ackLog`, jadi jalan otonom tanpa browser pun hasilnya menempel ke order (lihat bagian "Beberapa hal yang hanya kelihatan…").

### Beberapa hal yang hanya kelihatan dengan memantau berkas EA secara live

**`t=` di `sniper_trades.txt` berkedip untuk trade yang sudah lama tertutup.** `TzOffset()` dulu dihitung *per-panggil* sebagai `TimeCurrent() - TimeGMT()`, tapi `TimeCurrent()` hanya maju saat tick masuk sedangkan `TimeGMT()` jalan terus — selisihnya berkedip ±20 dtk. Baris trade memakai `DEAL_TIME - off`, jadi `t=` berubah-ubah terus (`1793423580 … 1793423604` di lima poll pertama). Akibatnya `if(outS == g_tradesCache) return;` tidak pernah cocok dan berkas statistik ditulis ulang tiap 5 dtk **selamanya**, dan batas "hari ini" di `RealizedToday()` (`g_haltDay + TzOffset()`) ikut bergeser. Sekarang offset diambil satu kali per sesi EA (`g_tzOff`, hanya diisi kalau `TimeCurrent()` dan `TimeGMT()` dua-duanya sudah sah). Terbukti di terminal FBS asli setelah reload build `13:33`: `t=` diam di `1793423589`, mtime `sniper_trades.txt` tidak berubah selama 12 dtk, `realized_today` tetap `1.08`.

**Partial close 50% di TP1 tidak mungkin terjadi di lot minimum — dan sudah terbukti terjadi di lot 0.02.** Di `ManagePositions()`, `closeV = floor(vol × InTP1Fraction / SYMBOL_VOLUME_STEP) × step`. Dengan `vol = 0.01`, step `0.01` (lot minimum FBS di BTCUSD): `floor(0.01×0.5/0.01) = 0` → `closeV = 0 < vmin`, jadi `PositionClosePartial` **tidak pernah dipanggil** dan cabang itu hanya mengeset `g_tp1Done=true` lalu `PositionModify(entry, tp2)` — artinya SL pindah ke entry dan TP naik ke TP2, satu lot utuh berjalan sampai TP2 atau time-stop. Log-nya akan berbunyi `partial=tidak`. Karena lot dihitung dari jarak SL (`riskusd ÷ (jarak_SL × usdPerPipLot)`), satu-satunya cara menguji 50%-nya adalah membuat jarak SL cukup lebar: ekuitas ~1054 dan `riskPct=1` ($10,54) dengan BTC `usdPerPipLot=1` → SL 400 points → `0,0263` → lot **0,02** = 2× step. `tools/tp1_rig.js` melakukan itu dengan geometri mekanis (SL 400p, TP1 +60p, TP2 +120p) dan bukan dengan sinyal scanner, supaya TP1-nya pasti tersentuh: order `2122443929` (BUY 0.02 @ 77289.95) masuk 15:03:48, dan 3 menit kemudian log EA menulis

```
15:06:51.669  SniperBridge (BTCUSD,H1)  SniperBridge TP1 BTCUSD partial=ya volume sisa 0.01
```

yang di sisi berkas terdokumentasi lengkap: `sniper_pos.txt` → `p1=1`, `pos1` di status berubah dari `0.02:77289.95:76889.95:77409.95` menjadi `0.01:77289.95:`**`77289.95`**`:77409.95` (SL = break-even, TP = TP2), `sniper_trades.txt` bertambah satu baris `vol=0.01;usd=0.72;why=EA;pid=2122443929`, dan `realized_today` naik 1,58 → 2,30 dengan `stats.n` 3 → 4. `tools/ea_sim.js` tidak pernah bisa menutup celah ini karena simulator itu tidak punya loop manajemen posisi sama sekali — jalur TP1/BE/partial hanya bisa dibuktikan di terminal. Catatan bentuk geometri: TP1 rig ada di `+60p` dari entry dengan SL 400p = **0,15R**, yaitu di bawah `InBeAtR=0.6`, jadi cabang break-even yang jalan *sebelum* TP1 (baris `PositionModify` di `if(InBeAtR > 0 && !g_tp1Done[i] && r >= InBeAtR …)`) terlewat oleh rig ini. Pada plan scanner itu justru cabang yang paling sering kena, karena `TP1_R=1.0` baru tersentuh setelah `0.6R` — tapi sampai tulisan ini dibuat belum pernah tereksekusi di terminal: tidak ada satu pun posisi yang mencapai +0,6R (order `2122432260`, TP1 di +446p dengan SL 446p = tepat 1,0R, keburu time-stop). Sisanya jadi jalur yang harus dibuktikan loop scanner otonom, bukan rig.

**`CLOSEALL` meninggalkan jejak di terminal tapi tidak di antrean order bridge.** Order `2122431010` (BUY 0.01 @ 77155.35, 13:30:32) tertutup jam ~13:40 dengan `why=EA` dan **+$0,44** — bukan TP1, bukan time-stop (tidak ada baris `TIME-STOP`/`TP1` di log EA), tapi penutupan oleh `DEAL_REASON_EXPERT`, yaitu tombol TUTUP SEMUA yang dikirim bridge. Yang membuat ini ketahuan justru celahnya: `closeAll()` **tidak** mendorong barisnya ke `state.json.orders`, jadi id `1000007` hilang dari daftar sementara `1000006` dan `1000008` ada — jeda nomor itu satu-satunya bukti perintah kontrol terlihat dari sisi bridge. Praktisnya: panel "JAWABAN TERMINAL" hanya menampilkan perintah `/signal`, jadi penutupan CLOSEALL harus dibaca dari `sniper_trades.txt`/`stats` (`why=EA`), bukan dari antrean order. Tidak mengubah eksekusi (EA tetap menutup dan ack tetap ditulis), cuma catatan bahwa laporan perintah kontrol tidak senyaman laporan order.


**Penolakan dari sisi EA tetap menghabiskan cooldown 15 menit.** Order rig pertama (`1000009`) ditolak guard kedua di terminal: `spread 1965 > 1963 pts (15.0% ATR 13089)` — hanya **2 points** di bawah plafon, dan itu contoh bagus bahwa penjaga EA bekerja persis di batasnya walau pakar bridge sudah memutuskan LAYAK. Yang tidak kelihatan dari angka itu: `state.lastOrderAt` di `bridge/server.js:550` ditulis saat perintah **dikirim**, bukan saat ack masuk, jadi order yang ditolak (posisi tidak pernah ada) tetap memicu `cooldownMs` penuh. Untuk manusia ini cuma mengganggu (rig kedua harus `/resume`), tapi untuk scanner otonom artinya satu penolakan spread yang bisa hilang dalam hitungan detik memakankan 15 menit kesempatan entry berikutnya. Perilaku ini sengaja **tidak** dilonggarkan — cooldown adalah penjaga, dan mengubahnya jadi "hanya dihitung saat ack ok" berarti order yang ditolak karena alasan lain (drift, margin, halt) bisa ditembak ulang setiap tick. Yang diubah hanya alatnya: `tools/tp1_rig.js` mengecek sendiri sisa cooldown dan memanggil `/resume` untuk rig ini.

**Jalur log runtime EA itu `MQL5/logs/`, huruf kecil, dan isinya UTF-16LE.** `Print()` di EA tidak masuk ke `MQL5/Experts/SniperBridge.log` (berkas itu justru berisi jurnal compile — `Result: 0 errors, 0 warnings, 5313 ms`), dan filesystem Linux di bawah Bottles bersifat case-sensitive, jadi `MQL5/Logs/20261031.log` **tidak ada** sementara `MQL5/logs/20261031.log` ada. Salah satu huruf dan seluruh baris runtime EA (order, TP1, TIME-STOP, `mulai — demo-only=YA`) tampak seperti tidak pernah dicetak. Cara membacanya:

```
iconv -f UTF-16LE -t UTF-8 "<…>/MQL5/logs/$(date -u +%Y%m%d).log" | tr -d '\r' | grep SniperBridge
```

Tanggal di nama berkas mengikuti jam **UTC**, bukan jam lokal — terminal dan panel mencetak jam lokal (baris `TP1` di atas tercetak `15:06:51` sementara berkasnya `20261031.log` yang dicari dengan `date -u` = `07:06`), jadi jangan pakai jam di dalam baris untuk mencocokkan nama berkas.


**Sinyal yang ditolak guard pernah menjadi "posisi hantu" di engine — sekarang dilepas.** Fire otonom pertama di data live (BTCUSD UP @ 77399.85, skor 0,622, 15:18:08) ditolak penjaga karena cooldown rig masih 40 detik, dan dari situ kelihatan dua hal. Pertama (sudah dicatat di atas): `sent[p] = tr.id` ditulis sebelum hasilnya diketahui, jadi sinyal itu hangus. Kedua, yang ini bug: `engine.js:350` menyetel `trade=plan` pada saat fire tanpa tahu ordernya dikirim atau tidak — mesin mengira memegang posisi yang tidak pernah ada. Efeknya `blocked='Plan aktif UP @ …  tunggu selesai'` mengunci pair sampai `PLAN_TTL` (60 menit), dan saat kedaluwarsa engine menutupnya sendiri (`finish('TIME', …)`) lalu memancarkan `CLOSE` yang di scanner diteruskan ke `rt.close()` → **hasil trade hantu masuk `state.hist`, yaitu riwayat yang dipakai R7 membekukan pair**. Di jalur browser ini tidak kelihatan karena panel memang menampilkan paper-trade; di jalur otonom ini racun. Perbaikannya kecil: `engine.abandon(id)` menjernihkan `trade` dan sengaja TIDAK menyentuh `lastEntry` (cooldown mesin tetap jalan supaya penolakan tidak dikejar-kejar tiap tick), dipanggil scanner saat `res.accepted=false`. Tertangkap regresi: `tools/scanner_test.js` §E (25 lulus) — dengan `abandon` dinetralkan, §E gagal persis di `"Plan aktif UP @ 81449.51 — tunggu selesai"` 12 menit setelah penolakan. Catatan jujur: assertion `hist` di §E belum terbukti menangkap hantu yang umur penuh — replay §E hanya 12 menit, sedangkan CLOSE hantu baru muncul di `PLAN_TTL` 60 menit.

**Cooldown penjaga tidak lagi membuang sinyal — `engine.js` punya `rearm()`.** Perilaku lama itu yang bikin fire otonom pertama (15:18:08) hangus: `sent[p] = tr.id` dicatat sebelum hasilnya diketahui, dan `abandon` membuat engine menahan cooldown mesinnya sendiri 15 menit, jadi peluang lewat dan tidak pernah diketuk lagi. Sekarang `guardDecide` menandai penolakannya dengan `kind` (`kind:'cooldown'` satu-satunya yang bersifat waktu), `submit()` meneruskannya sebagai `res.blockKind`, dan scanner membedakan dua kasus: penolakan **waktu** → `engine.rearm(id)` (lepas rencana, reset `lastEntry`, mulai ulang jendela konfirmasi → fire berikutnya memakai harga tick terbaru), penolakan **penilaian** (cap +$25, batas rugi −$10, halt, akun non-demo, R7/R8 dari pakar) → tetap `abandon`, tidak dikejar-kejar. Yang jelas tidak berubah: cooldown itu sendiri tetap 15 menit dan tetap mengikat — yang berubah hanya bahwa kandidatnya tidak dibuang, ditunda. §F (5 assertion, total 30 lulus) membuktikannya: dengan `rearm` dinetralkan, §F gagal di `"mesin memancing ulang sinyalnya"` (`fired` mentok 1 selama 15 menit cooldown), sedangkan dengan perbaikan `fired` naik lagi dan order ditulis pada fire pertama setelah cooldown habis dengan `price=` sama dengan ask/bid sisi eksekusi saat itu. Assertion ke-4 §F tetap lulus tanpa `rearm` (fire alami berikutnya memang muncul belakangan di data), jadi yang membedakan perilaku adalah assertion ke-2.

**Fire otonom pertama yang benar-benar menulis order ke terminal — dan jawabannya tidak pernah sampai ke mesin.** 16:15:19 scanner mengunci plan BTCUSD dan mengirimnya lewat jalur produksi (`dryRun:false`, `autoArm:true`): order `1000012`, BUY @ 77386.85, SL 77023.16, TP1 77750.54 = persis 1,0R (geometri plan, bukan rig), TP2 78186.97 = 2,2R. Beberapa detik kemudian EA menjawab `ok=0 — spread 1965 > 1696 pts (15.0% ATR 11305)`; penjaga kedua di terminal bekerja seperti yang didokumentasikan di atas, dan tidak ada posisi yang pernah ada. Yang bikin kejadian ini penting bukan penolakannya, tapi sisi bridge-nya: `info.counts` mencatat order itu sebagai **`accepted`**, karena `submit()` mengembalikan `accepted=true` begitu baris perintah ditulis (`bridge/server.js:548`) dan ack `ok=0` hanya ditempel ke `state.orders[].ack` di `api.acks()` — tanpa pernah memberi tahu engine. Artinya `trade` masih plan: pair terkunci `"Plan aktif …  tunggu selesai"` sampai `PLAN_TTL` 60 menit dan CLOSE hantunya menyetor hasil ke `state.hist`, yaitu persis racun yang sudah dibersihkan untuk penolakan guard lokal. Bolongnya masih ada karena yang diperbaiki hanya satu dari dua jalur penolakan. Perbaikannya sekarang menutup keduanya: order menyimpan `planId` (id plan engine, bentuk `PAIR|<ms tick>|UP`), `api.acks()` menyalin setiap jawaban ke cincin `state.ackLog` (30 terakhir, ikut `save()`, jadi siapa yang membaca duluan tidak menyembunyikannya dari yang lain), dan penolakan EA diklasifikasikan dengan `eaRejectKind(reason)` pakai kosakata yang sama dengan penjaga: `spread` / `harga sudah lari` / `terlalu dekat` / `stops level` = **waktu** → `engine.rearm()`, sisanya (`HALT`, `sudah ada posisi …`, `saldo tidak cukup untuk lot minimum`, margin, plan cacat) = **penilaian** → `engine.abandon()`. Scanner memanggil `routeAcks()` sebagai langkah pertama `tick()`, jadi ia juga yang menguras `sniper_ack.txt` — sebelumnya satu-satunya pemanggil `rt.acks()` adalah rute `GET /status`, jadi jalan otonom tanpa panel browser tidak pernah membaca jawaban terminal sama sekali. §G membuktikan dua sisinya: penolakan spread memancing ulang kandidat dengan harga tick terbaru (`plan2.t ≠ plan1.t`, masih ≤ 100 points dari ask), penolakan "sudah ada posisi" membuangnya dan pair tertahan cooldown mesin (`blocked = Cooldown …`), dan `ack ok=1` justru TIDAK melepas rencana. Dinetralkan (`routeAcks()` langsung `return`), §G gagal 8 assertion — termasuk `"Plan aktif UP @ 81449.51 — tunggu selesai"` yang muncul persis seperti hantu di lapangan. Total `tools/scanner_test.js` 41 lulus/0 gagal; `bridge_test.js` 91, `bridge_http_test.js` 34, `tools/ui_smoke.js` 0 error runtime. Panel baris AUTO OTONOM ikut menampilkan pemisahan ini: `… diterima 1 • ditolak 1 • jawaban EA 0 ok / 1 tolak` (`app.js?v=13`), karena "diterima" di baris itu memang berarti "ditulis", bukan "jadi".

**Yang menahan itu bukan penjaga, tapi jam: `rearm()` terkonfirmasi di produksi, bukan cuma di §F.** 16:18:31 fire kedua BTCUSD (entry 77403.15) ditolak dengan `cooldown 708 dtk lagi` — `lastOrderAt` masih milik order `1000012` yang justru ditolak terminal. Dengan perbaikan sebelumnya candidate itu harusnya sudah dibuang; yang kelihatan di `/status.scanner.warm.BTCUSD` sekarang `stage=SETUP`, `confirming=true`, reason `"Konfirmasi 8s (60%) — tunggu sampai TERKUNCI (hijau)"` — mesin memancing ulang sinyalnya dengan harga tick terbaru sementara cooldown 15 menit penjaga tetap utuh.

**Scanner sekarang punya jejak peristiwa, karena anomali jam 16:15–16:18 tidak bisa direkonstruksi tanpa itu.** `info.counts` hanya angka kumulatif dan tidak ada satu pun baris yang ditulis per fire, jadi ketika fire#2 muncul tiga menit sesudah fire#1 — padahal `PLAN_TTL` 60 menit dan `state.hist` masih kosong (jadi `finish()` tidak pernah terjadi) — tidak ada cara membedakan "rencananya dilepas karena ack" dari "engine-nya dibuang dan diganti baru". Tersangka terkuat yang tersisa itu sendiri: `ensure()` menghapus engine setiap kali pair sesaat keluar dari daftar scan (`bridge/scanner.js:53` — status tanpa `mkt9`, atau pair yang sedang dianggap libur), dan `trade` tidak disimpan di mana pun, jadi rencananya hilang tanpa jejak bersama engine-nya. Yang berubah sekarang cuma pengukurannya, bukan perilaku: scanner mencatat cincin 40 peristiwa (`fire` / `order` / `reject` / `ack-ok` / `ack-no` / `rearm` / `abandon` / `engine-drop`, masing-masing dengan pair + alasan) di `info().events`, dan bridge yang diluncurkan normal mencetaknya sebagai `[scanner HH:MM:SS] …` ke stdout (jadi `tools/autostart.sh` / `/tmp/sniper_bridge.log` ikut menampungnya). `engine-drop` yang membawa plan aktif adalah baris yang harus dibaca kalau keanehan itu muncul lagi — kali ini ia belum terbukti, dan ditulis apa adanya.

**Rig pertama yang menguji jalur ack di produksi — dan yang membuat instrumentasi baruku ketahuan berbohong.** 16:44:24 `POST /signal` dengan geometri mekanis (BUY BTCUSD @ 77246.35, SL 400 pips, TP1 +60, TP2 +120, `planId` ikut dikirim) → order `1000013` ditulis → `ack ok=0 — spread 1965 > 1753 pts (15,0% ATR 11688)`. Yang tercatat: `counts.eaNo` naik ke 1, `stats.byPair.BTCUSD.orders` jadi `sent 8 • diterima 4 • ditolak 4`, `open=0`, ekuitas tidak berubah. Ini membuktikan dua hal yang tadinya cuma headless: ack benar-benar dikuras dan routed oleh scanner sementara panel browser tetap polling `/status` (cincin `state.ackLog` membuat siapa-yang-membaca-duluan tidak penting lagi), dan `eaRejectKind` mengkategorikan alasan EA yang asli dengan benar (`spread` = waktu). Yang **tidak** boleh dipakai sebagai bukti: baris `rearm plan BTCUSD|1793436263000|UP` pada peristiwa itu palsu. `planId` kiriman rig tidak pernah dipegang engine mana pun (ia punya rig, bukan fire scanner), `engine.rearm()` diam-diam menolak karena id-nya tidak cocok — tapi scanner tetap mencatatnya sebagai pelepasan. Sekarang `release()` memeriksa `e.trade.id === planId` lebih dulu; yang tidak cocok dicatat sebagai `stale … tidak lagi dipegang mesin` dan hitungan `eaNo` tetap naik karena jawabannya memang masuk. §H (3 assertion) mengunci itu: `ack-no [time]` terbaca, tanpa `rearm`/`abandon`, engine tetap `trade === null`. Total `tools/scanner_test.js` 44 lulus/0 gagal. Dua baris yang sudah terlanjur masuk `/tmp/sniper_bridge.log` (`[scanner 08:44:26] ack-no … [time]` + `[scanner 08:44:26] rearm …`) dibiarkan apa adanya sebagai bukti: keduanya ditulis build **sebelum** pemeriksaan id, jadi `rearm` di situ memang baris yang tidak boleh dibaca sebagai pelepasan sungguhan — dan sekaligus alasan prefiksnya sekalian dipindah ke jam lokal, karena `toISOString()` mencetak UTC sementara terminal dan panel mencetak jam lokal (+8 di laptop ini), persis jebakan nama berkas `MQL5/logs/` yang sudah dicatat di atas. Artinya juga: **rearm/abandon yang sungguhan di produksi masih menunggu fire alami scanner**, karena satu-satunya `planId` yang dikenal engine adalah yang lahir dari `fire()` itu sendiri — rig tidak bisa memancingnya, sama seperti `tools/ea_sim.js` tidak pernah bisa menyentuh loop TP1. Satu hal lagi yang ikut terkonfirmasi oleh rig ini dan sudah tercatat di atas: penolakan terminal tetap memakan cooldown penjaga penuh — sesudah restart, `guard` menjawab `cooldown 805 dtk lagi` sementara `open=0` dan tidak ada posisi yang pernah ada; `lastOrderAt` bertahan melewati restart (bersama antrean order dan `ackLog`), dan restart tidak mengirim order ulang.

**Zona mati antara audit biaya pakar dan plafon spread EA — ini yang membuat loop otonom tidak pernah bisa membuka posisi.** `GET /status` jam 17:0x dipakai untuk menguji hipotesis sederhana: berapa banyak pair yang LAYAK di mata pakar tapi pasti ditolak oleh EA. Jawabannya, dengan angka broker asli dari `sniper_status.txt` (`spreadPts`, `atrPts`): pakar meloloskan pada `ATR/biaya ≥ 2,4×`, sementara EA (`SniperBridge.mq5:390`) memaksa `spread ≤ maks(30 pts, 15% × ATR)` = `ATR/biaya ≥ 6,67×`. Di antara keduanya semuanya ditolak sebelum sempat ditulis — BTCUSD justru ada persis di tengah zona itu dan jadi satu-satunya pair yang LAYAK (`ok=true`, rasio 5,79×): spread 1965 pts, plafon 1736 pts. Jadi 8 order yang tercatat hari itu (`sent 8 • diterima 4 • ditolak 4 • open 0`) bukan nasib buruk, melainkan konsekuensi aritmetika dua ambang yang tidak pernah dicocokkan. Sekarang scanner meniru rumus EA **sebelum** memanggil `rt.submit()`, memakai poin broker (bukan estimasi pip si pakar) sehingga lantainya ikut sama: `eaSpreadCap(m)` di `bridge/scanner.js:26`, dipanggil di `fire()` — kalau `m.spreadPts` melebihi plafon, tidak ada order, `counts.skipped` naik, peristiwa tercatat sebagai `ea-gate`, dan rencananya **dipancing ulang** (`release(...,true)`) karena spread yang melebar itu urusan waktu, sama seperti ack `spread` dari terminal. Konsekuensi yang harus diterima: dua angka 30 pts / 15% itu sekarang hidup di dua tempat, jadi kalau `InMaxSpreadPoints` / `InMaxSpreadAtrPct` diubah di chart, salinannya di scanner harus diubah juga — itu-satu-satunya yang mengikat keduanya. §I (7 assertion, termasuk kontrol bahwa dengan spread 0,05×ATR order tetap benar-benar keluar, supaya "nol order" tidak bisa dicapai cuma dengan membuat scanner macet) mengunci itu; total `tools/scanner_test.js` **51 lulus/0 gagal**. Bridge produksi sudah direstart dengan pagar ini (17:2x, `LIVE-DEMO` + `scanner=ARM` bertahan dari `bridge/config.json`, `counts` mulai dari nol lagi), dan kondisi market saat itu masih di dalam zona mati (`spreadPts 1965`, plafon 1681, rasio 5,70) — baris `ea-gate` pertama akan kelihatan di `/tmp/sniper_bridge.log` begitu fire berikutnya muncul.

**`tools/ui_smoke.js` keluar dengan exit code 1 tanpa pernah menyebut alasannya — dan itu menyembunyikan satu pemeriksaan yang selalu gagal.** Lognya mencetak `error runtime : 0 (bersih)` di tengah jalan, lalu enam pemeriksaan isi panel (`autoArm`, baris scanner, kelengkapan tabel statistik) menambahkan masalahnya ke array `errors` **setelah** baris itu dicetak, dan penutupnya cuma `process.exitCode=errors.length?1:0`. Jadi "0 error runtime" yang selama ini dikutip di README itu benar — tapi exit code-nya sudah lama 1 dan tidak ada satu pun teks yang menjelaskan kenapa. Yang ketahuan: pemeriksaan baris AUTO OTONOM mencari `'autoArm OFF'` di `scanLine`, padahal string itu ditulis `app.js:666` ke elemen `scanState`; `scanLine` hanya kebagian `sc.err` (`rencana terkunci tapi autoArm=false …`). Assertion itu tidak pernah bisa lulus sejak ditulis — ia tidak ada hubungannya dengan perubahan scanner hari ini, dan dibuktikan dengan membandingkan `git show :app.js`/`:tools/ui_smoke.js` (versi sebelum sesi ini) yang gagal dengan cara yang sama. Yang diperbaiki: sisa `errors` sekarang dicetak sebelum exit (`✘ pemeriksaan isi panel gagal (N): …`), dan assertion-nya membaca gabungan `scanState + scanLine` dengan pola `/autoArm\s*(OFF|=false)/i` sehingga tetap menuntut hal yang sama (operator diberi tahu status arm) tanpa menuntut string yang salah tempat. Setelah itu `node tools/ui_smoke.js` **exit 0** — baik mode biasa maupun `FX_SNIPER_EMPTY_STATS=1` — dan `tools/ea_sim.js`, `tools/bridge_test.js` (91), `tools/scanner_test.js` (51) tetap hijau dengan `engine.js` yang baru.

**Kesimpulan signal_test belum boleh dipakai untuk mengubah mesin tanpa data baru.** Dua hal menggantung dengannya. Pertama, satu-satunya sinyal yang signifikan secara statistik (emas berdiri di sisi yang salah, p=0,006–0,010) ditemukan di jendela 45 hari yang sama dengan semua penolakan kalibrasi sebelumnya — membalikkannya jadi "strategi emas short-momentum" adalah persis pola pikir yang sudah dihukum walk-forward, jadi minimal butuh `node tools/fetch_klines.js PAXGUSDT --days 90` dan uji ulang di potongan yang tidak pernah dilihat. Kedua, pertentangan `BRK_CEIL` (sweep: memperketatnya menaikkan avgR; signal_test: sampel yang dia tolak justru punya edge lebih tinggi) belum terselesaikan dan tidak boleh dipilih salah satunya hanya karena enak — penyebab paling mungkin adalah avgR diukur sesudah geometri keluar+biaya sementara signal_test mengukur drift mentah, dan itu bisa diuji dengan menjalankan keduanya di grid yang sama. Status produksi saat log ini ditulis: **pasar FX tutup (Sabtu)**, `terminal64` sudah dimatikan operator, `sniper_status.txt` berhenti jam 18:04:09 — jadi bukan regresi, dan `tools/order_test.js` exit 1 dengan pesan yang benar (`pakar masih menolak BTCUSD: R1 data (status EA basi)`). Fire alami scanner + baris `ea-gate` pertama menunggu market buka lagi.

### Belum terverifikasi

Perilaku EA saat runtime tidak bisa diuji headless — menempelkan EA ke chart butuh GUI terminal. Yang sudah diverifikasi di lingkungan ini: `tools/compile_ea.sh` → compile 0 error/0 warning (build `13:33` dan `14:04`), `tools/bridge_test.js` → 91 lulus/0 gagal, `tools/bridge_http_test.js` → 34 lulus/0 gagal, `tools/scanner_test.js` → 51 lulus/0 gagal, `tools/ea_sim.js` → jalur plan→order→ack bolak-balik + panel statistik, `tools/ui_smoke.js` → 0 error runtime dengan panel AUTO, baris scanner, dan panel statistik ikut ter-render. Order nyata sudah pernah terjadi: `node tools/order_test.js BTCUSD` → ack `ok=1 ticket=2122418796` di akun DEMO FBS, jadi plan→order→ack→posisi ujung-ke-ujung sudah terbukti. Runtime EA juga sudah teramati dari berkas: `sniper_status.txt` diperbarui terus (`pos1=BTCUSD:2122418796:0.02:...:-0.68`, `openrisk=9.42`, `realized_today=0.00`) dan dari situ justru bug-bug di atas kelihatan. **Time-stop juga sudah terbukti di terminal asli**: order 12:12:58 ditutup sendiri jam 13:13:00 (`SniperBridge TIME-STOP BTCUSD`, deal #1886954611 sell 0.02 @77213.90 = +$1,08), lalu `WriteTrades()` menuliskan barisnya (`side=BUY` dibaca dari deal MASUK, `why=EA`, `t` sudah dikonversi ke GMT) dan bridge membacanya sebagai `available=true n=1 bersih=$1.08 byWhy={EA:1.08}` dengan `realized_today=1.08`, `open=0`, `openrisk=0.00`, `sniper_pos.txt` kembali kosong, dan R7 tidak membekukan BTCUSD (masih di bawah `minSample`). Pemulihan state juga terbukti untuk jalur **EA dilepas-pasang**: jam 13:01 EA dimuat ulang dan `sniper_pos.txt` mengembalikan `g_openAt` sehingga time-stop tetap jatuh tepat 60 menit setelah order, bukan 60 menit setelah reload. Diulang jam 13:37 dengan **posisi masih terbuka** dan build baru di chart: `sniper_status.txt` langsung `build=2026.10.31 13:33`, `open=1`, `pos1=BTCUSD:2122431010:0.01:77155.350000:76538.110000:77926.900000:…`, `sniper_pos.txt` mempertahankan `tk=2122431010;…;p1=0;open=1793431831`, `sniper_req.txt` tetap kosong dan `lastid=1000006` — jadi reload tidak menimbulkan order ganda maupun posisi yang kehilangan pengelolaan. Order nyata kedua (ticket `2122431010`, BUY BTCUSD 0.01 @ 77155.35) kali ini bukan dari `tools/order_test.js` tapi dari jalur produksi penuh: `POST /config {dryRun:false}` → guard `allow:true` → `POST /signal` dengan payload persis seperti yang dikirim panel (`pair/side/entry/sl/tp1/tp2/score`) → ack `ok=1` tertempel di antrean order `state.json` dan `floating` muncul di `stats`. Order ketiga (`2122432260`, BUY 0.02 @ 77281.85, SL 76835.85, TP1 77727.85) juga dari jalur yang sama, dan **lot 0.02 ini yang pertama kali membuat partial close 50% secara aritmetika mungkin**. Order keempat (`2122443929`, BUY 0.02 @ 77289.95) dikirim `tools/tp1_rig.js` dan yang pertama menutup sebagian: 15:03:48 order → 15:06:51 `TP1 partial=ya volume sisa 0.01` (+$0,72) → `p1=1`, SL di entry, TP2 di atasnya. Bridge-nya sendiri direstart di tengah posisi itu (jadi proses `node bridge/server.js --live --arm` kini jalan lepas dari sesi shell, log di `/tmp/sniper_bridge.log`) dan tidak ada yang berubah di sisi terminal: `state.json` mempertahankan `lastOrderAt`, daftar order dan ack, `stats.n` tetap 4, dan posisi tetap dikelola EA — restart bridge tidak mengirim order ulang.

Yang **belum** pernah tereksekusi dan cuma bisa dibuktikan oleh posisi yang menutup sendiri di terminal: break-even di `InBeAtR=0.6` pada geometry scanner (rig sengaja menaruh TP1 di 0,15R jadi cabang itu terlewat — lihat catatan di atas), jalur rugi penuh di SL, cap +$25 / −$10 dengan angka nyata, loop ARM dari browser (order dikirim lewat `POST /signal` dengan payload yang sama, bukan dengan menekan tombol ARM dua-klik di panel — jadi `app.js` sendiri belum pernah ikut jalur ini), transisi buka/tutup bursa dengan EA terpasang, dan pemulihan setelah **terminal** restart (yang di atas baru reload EA di terminal yang tetap hidup, plus restart proses bridge di atas). Untuk scanner otonom: rantainya sudah terbukti headless di `tools/scanner_test.js`, prosesnya jalan di bridge produksi (`GET /status.scanner` = `running:true`, pair `BTCUSD/ETHUSD` sesuai bursa yang buka), dan `sniper_bars.txt` sekarang **sudah ada** (build `14:04` menulisnya, ~117 kB M1 per simbol) — jadi scanner tidak lagi hangat-dari-tick dan langsung menampilkan `stage=WATCH` dengan alasan yang bisa dibaca: `BTCUSD UP skor 0,22 — Pasar choppy (ER 0,06 < 0,32) • Skor 0,22 < 0,48 • Mom/trend terlalu lemah`, `ETHUSD UP skor 0,31 — ATR/biaya 1,7× < 2,4×`. Yang tersisa dari loop otonom bukan lagi "satu fire nyata" — fire nyata sudah terjadi dua kali (16:15:19 order `1000012` ditulis lalu ditolak guard spread terminal, 16:18:31 ditolak cooldown penjaga dan kandidatnya dipancing ulang) — yang belum tertutup adalah **fire otonom yang sampai menjadi posisi lalu menutup dirinya sendiri** (order → posisi → penutupan → statistik), dan itu tertunda dua hal: semua gerbang biaya masih menolak (benar, bukan macet), dan slot tunggal BTCUSD (R8) dipegang rig sampai posisi itu menutup sendiri. Panel statistik dan baris AUTO OTONOM dibuat supaya jalur-jalur itu kelihatan, bukan tersembunyi: `ALASAN PENUTUPAN` sekarang `EA: 4 tutup` dengan `wins 4 / losses 0`, jadi hitungannya nyata walau masih empat sampel — dan angka itu sendiri sudah cukup untuk tidak boleh dibaca sebagai edge. Dan `stats.available` baru `true` setelah chart me-load `.ex5` hasil compile terakhir — selama belum, lepas EA dari chart, seret ulang Navigator → Expert Advisors → SniperBridge, aktifkan Algo Trading, lalu cek `ea.build` harus menunjukkan jam compile, bukan `00:00`.


## Akhir pekan & hari libur: hanya BTC dan ETH

Bursa FX tutup Jumat 22:00 UTC sampai Senin 00:00 UTC, dan itu bukan cuma label — feed-nya benar-benar mati. Diuji langsung ke Deriv hari Sabtu: `cryBTCUSD` dan `cryETHUSD` tetap mengirim tick, sedangkan `frxEURUSD` dan `frxXAUUSD` menjawab `{"code":"MarketIsClosed","message":"...will open at 2026-11-02 00:00:00"}`. Jadi di luar jam bursa yang tersisa untuk dipindai dan dipesan hanyalah crypto.

- **`engine.js`**: `closedFX(t)` = akhir pekan + `FX_HOLIDAYS` (tanggal tetap: 01-01, 12-24, 12-25, 12-26, 12-31). Yang tanggalnya bergerak (Good Friday, Easter Monday, bank holiday Inggris) tidak bisa dihitung dari tanggal — tambahkan sendiri ke `FX_HOLIDAYS`. `isClosed(pair,t)` melewatkan pair `h24` (BTC/ETH).
- **`app.js`**: `scanKeys()` menyusut ke pair `h24` saat bursa tutup, dan fokus pair dipindah otomatis (EUR/USD yang tidak punya harga tidak lagi jadi default). Batas Jumat/Minggu dideteksi di loop render → feed dilanggan ulang sendiri, jadi aplikasi boleh dibiarkan menyala melewati akhir pekan. Header menampilkan "BURSA FX TUTUP · hanya BTC & ETH yang dipindai". Feed yang tidak punya pasangan crypto (OANDA/Capital lewat proxy) tetap menampilkan daftar FX dengan status tutup, tidak jadi papan kosong.
- **`bridge/server.js`**: aturan R2 menolak semua pair non-`h24` dengan alasan "bursa FX libur/akhir pekan — hanya BTC & ETH yang bisa dipesan", dan `GET /status` mengirim `session:{fxClosed, tradable, holidays}` supaya UI/otomasi lain bisa membaca yang sama.

Ujinya: `node tools/ui_smoke.js BTCUSDT 12 balanced action 56` — argumen keenam menggeser jam replay 56 jam sehingga jendela data Jumat jatuh ke Sabtu; jalur "bursa tutup" ikut dirender tanpa terminal.

## Emas, BTC, ETH (v4.1)

| Pair | Binance | Deriv | Catatan |
|---|---|---|---|
| **XAU/USD** | `PAXGUSDT` (token emas, selisih kecil vs XAUUSD → pakai SYNC OFFSET) | `frxXAUUSD` | pip = $0.10, 1 lot = 100 oz, sesi 07–20 UTC, tutup weekend |
| **BTC/USD** | `BTCUSDT` | `cryBTCUSD` | pip = $1, 24/7, tidak kena filter weekend |
| **ETH/USD** | `ETHUSDT` | `cryETHUSD` | pip = $0.10, 24/7 |

- Ukuran kontrak per lot (`units`), `typSpread`, `maxSpread` di `engine.js` adalah **asumsi** — samakan dengan spesifikasi simbol di MT5-mu (BTC/ETH ada broker yang 1 koin/lot, ada yang lain).
- Gerbang ATR÷biaya paling sering menahan BTC/ETH bila `typSpread` lebih besar dari volatilitas 1 menit. Itu disengaja; turunkan `typSpread` hanya jika spread brokermu memang lebih kecil.
- OANDA/Capital.com lewat proxy: proxy harus memetakan XAUUSD/BTCUSD/ETHUSD (file proxy tidak ikut diubah). Paling mudah pakai Deriv atau Binance.
- `NEWS_BLACKOUT` berlaku juga untuk BTC/ETH (rilis data AS menggerakkan crypto).
- Backtest: `node backtest.js ticks.csv --pair BTCUSD`. Kalibrasi terpisah per pair — parameter FX tidak otomatis cocok untuk emas/crypto.

## Perubahan v8 (auto-order MT5 demo)

- **`mt5/SniperBridge.mq5`** (baru) — EA bridge + otoritas order: baca `sniper_req.txt`, tulis `sniper_ack.txt`/`sniper_status.txt`/`sniper_pos.txt`/`sniper_trades.txt`, guard penuh (demo-only, halt cap/rugi/floor, margin free, satu posisi per simbol, stop-level, drift harga, spread, slippage), BE di `InBeAtR`, partial 50% di TP1, time-stop, pemulihan restart. Compile 0 error/0 warning lewat `tools/compile_ea.sh`.
- **Bug satuan guard spread/drift (ketemu saat uji pertama di terminal FBS asli)** — `InMaxSpreadPoints=30` dan `InMaxPriceDriftPts=15` itu points untuk FX; di FBS point ETH/BTC = 0.01 sehingga spread normal (ETH 193 pts, BTC 1965 pts) selalu ditolak dan order yang sah dituduh "harga sudah lari". Sekarang plafonnya `max(floor points, InMaxSpreadAtrPct% × ATR simbol)` dan `max(floor points, InMaxDriftPct% × harga)` — input baru `InMaxSpreadAtrPct=15`, `InMaxDriftPct=0.02`, perilaku FX tidak berubah.
- **Dua bug lagi, ketemu dari log runtime pertama (posisi nyata BTCUSD 0.02 @77159.95)** — (1) `WriteTrades()` punya `if(outS == g_tradesCache) return;` dengan cache awal `""`, jadi selama belum ada satu pun deal penutupan berkas `sniper_trades.txt` **tidak pernah dibuat**; bridge membacanya `stats.available === false` dan panel menuduh build EA lama padahal EA-nya baru. Sekarang berkasnya ditulis sekali di langkah pertama walau kosong (bridge memang sudah memperlakukan "berkas ada, nol trade" sebagai tersedia — sisi bridge tidak berubah). (2) `build=` memakai `TimeToString(__DATE__, TIME_DATE|TIME_MINUTES)` dan `__DATE__` tidak punya jam, sehingga build yang jalan tertulis `2026.10.31 00:00` dan dua compile dalam satu hari (yang di chart jam 12:09 vs yang baru jam 12:36) tampak identik — sekarang `__DATETIME__`.
- **`tools/ea_sim.js` ikut disamakan dengan guard EA yang berubah** — sisi simulator masih memegang plafon lama `spread > 30 pts` / `drift > 15 pts`, yaitu guard yang justru sudah dibuang di mq5, jadi simulator menguji jalur yang tidak ada lagi. Sekarang rumusnya disalin (`max(30, 15% × ATR)` dan `max(15, 0.02% × harga)`), statusnya ikut mengirim `build`, dan `sniper_trades.txt` kosong dibuat di awal. Langkah 11 kini tercetak `drift 9990 pts > maks 220`.
- **Panel PER MARKET sekarang mendaftar SEMUA pair yang dipindai** (`app.js`) — blok itu dulus dibangun dari `Object.keys(s.byPair)`, dan `byPair` hanya berisi pair yang punya baris penutupan, jadi selama riwayat kosong bloknya hilang tanpa penjelasan dan setelah ada satu trade hanya satu pair yang muncul. Sekarang daftar 10 pair scanner (plus simbol broker yang dipetakan ke pair), yang belum punya hasil mendapat baris `0 ditutup • <alasan>` dengan alasan dari ranking hari ini (R2 sesi / R4 biaya / R5 saldo / "layak hari ini — belum ada yang dipesan" / "simbol ini tidak dilaporkan EA hari ini"); pair yang sudah ditutup tetap lebih dulu, urut bersih terbesar. Blok kepala (`WINRATE`/`BERSIH`/`PROFIT FACTOR`/`HARI INI`) tetap tidak ditampilkan saat `n=0` supaya tidak ada angka nol yang terlihat seperti hasil. Aset di-cache-bust `?v=12`, dan `tools/ui_smoke.js` punya mode `FX_SNIPER_EMPTY_STATS=1` yang mengosongkan `stats` (n=0, `byPair={}`) untuk menguji jalur baru itu: 10 pair terdaftar, 0 pair tanpa baris, 0 error runtime — mode default tetap 13 baris.
- **`bridge/server.js`** (baru) — HTTP lokal + expert system (aturan R1–R9 dengan alasan per penolakan, termasuk "lot minimum tidak muat dengan saldo ini") + guard harian (cap +$25 sebagai *stopper*, rugi −$10, floor ekuitas, watchdog 20 s, cooldown) + auto-discover `MQL5/Files` di bottle. Default DRY RUN; `volume` selalu 0 ke EA supaya lot hanya dihitung satu tempat. STOP/RESUME/CLOSEALL diteruskan ke EA lewat file perintah yang sama dengan id dari antrean yang sama.
- **`app.js` / `index.html` / `styles.css`** — panel AUTO-ORDER (status EA, guard, daftar pakar + alasannya, baris JAWABAN TERMINAL, DRY RUN, ARM dua klik yang baru aktif kalau `ea.mode==='demo'`, STOP/RESET/TUTUP SEMUA), satu perintah per rencana terkunci, laporan hasil lewat `/update`. `PARAMS.BAR_MIN` tetap 15; aset di-cache-bust `?v=10`.
- **`tools/bridge_test.js`** (baru) — 66 assertion guard + pakar + perintah kontrol + sesi libur di temp dir (tidak menyentuh repo): parser status, R1–R9, setiap jalur guard, `submit()` (dry run vs tulis order, cooldown, pair tak dikenal), ack, HALT/RESUME/CLOSEALL + id yang tidak pernah ≤ `lastid` EA, auto-discovery, akhir pekan/hari libur hanya BTC & ETH.
- **`tools/bridge_http_test.js`** (baru) — 23 assertion lewat HTTP sungguhan (`http://127.0.0.1:<port>`): rute, format KV di berkas, ack satu-kali **dan ditempel ke order-nya** (ticket/reason tersimpan di `state.json`), dry-run→live, halt menutup jalur, watchdog menahan saat status basi.
- **`tools/ea_sim.js`** (baru) — simulator sisi EA (format `sniper_status.txt`/`sniper_ack.txt` identik dengan `WriteStatus()`/`Ack()` di mq5) + bridge asli di port 8791; menguji bolak-balik plan→order→ack→posisi→realisasi termasuk penolakan dari dalam EA.
- **`tools/ui_smoke.js`** kini memalsukan `fetch` ke bridge, jadi panel AUTO ikut dirender tanpa terminal: 0 error runtime, churn board 0.5 perubahan baris/jam, kartu 🔒 tetap 100% terpaku (12 jam replay).
- Belum diuji: perilaku runtime EA di chart (butuh GUI), dan segala hal di akun real — fitur ini memang tidak untuk itu.

## Perubahan v7 (anti-kedip, multi-timeframe, kalibrasi)

Masalah yang dilaporkan: pair yang lolos threshold hanya muncul sebentar lalu hilang dan tidak pernah terkunci.

- **Latch konfirmasi** (`engine.js`): `prog` diakumulasi, satu gate yang kedip tidak lagi menolaknya. Ada `CONFIRM_GRACE` 6 dtk toleransi, lalu meluruh `BLEED_DECAY` 2× (bukan nol mendadak), dan `SOFT_HOLD` melonggarkan ambang hanya saat sedang countdown. Kondisi **plan aktif / cooldown / batas rugi harian** dipisah dari gate sinyal (`blocked`, prog dibekukan) — dulu ini dianggap kegagalan struktur sehingga kartu jatuh ke WATCH dan hilang dari board.
- **`brkScore` dibuat simetris** — rumus lama memberi skor positif berlebih ke sisi BUY, sehingga sinyal SELL hampir tidak pernah lolos.
- **Kartu ENTRY dipaku**: `stableSignal()` menahan kartu selama plan hidup (100% pada uji 7 hari), plus retensi latch 30 dtk setelah sinyal lepas. Ambang "nyaris lolos" pakai hysteresis (`NEAR_ENTER` .85 / `NEAR_EXIT` .65) supaya baris tidak berkedip di sekitar batas.
- **Board tidak ditulis ulang bila isinya sama** (`setBoard` + diff), jadi DOM tidak di-rebuild 2 Hz.
- **Board multi-scanner ternyata tidak punya CSS sama sekali** (`.alertCard`, `.scanRow`, `.pill`, `.cdBar`, `.historyList` dst.) — seluruh blok styles ditambahkan di `styles.css`.
- **Timeframe bar sinyal jadi parameter** (`BAR_MIN` 1/3/5/15 menit, default 5): bar 1m dibangun dari tick, lalu diagregasi; prefill histori (Binance `interval=1m`, Deriv `granularity=60`) disesuaikan dengan `BAR_MIN` lewat `needBars()`, label TF ikut ditampilkan di header.
- **Alat baru**: `tools/fetch_klines.js`, `tools/calibrate.js`, `tools/latch_test.js`, `tools/ui_smoke.js` (lihat bagian Kalibrasi).
- Verifikasi: `ui_smoke` 0 error runtime, churn board 0.8 perubahan baris/jam, kartu 🔒 terpaku 100%; `latch_test` 0.6 pergantian stage/jam, 100% kandidat/ENTRY tetap tampil selama plan aktif.

## Perubahan v4 (anti-SL)

- **SL berbasis swing**: SL = max(3.2×ATR1m, swing 10 menit + 0.5×ATR, 6×biaya, 6 pips). Jika SL > 7×ATR → entry **ditolak** (invalidasi terlalu jauh).
- **Filter anti-kejar**: tolak bila harga sudah lari (z1m > 2.4 / z3m > 2.8), sedang di puncak/dasar range 15m (brk > 0.88), atau sudah retrace > 1×ATR dari ekstrem 3 menit.
- **Blackout berita** (`NEWS_BLACKOUT`, menit-UTC, edit sesuai kalender) dan jeda 90 menit setelah 2 SL beruntun.
- **Konfirmasi lebih lama**: `persist` 15–40 detik (dulu 3–12 detik) dan ambang skor/ER/ATR-biaya dinaikkan.
- **Manajemen**: TP1 1.0R, TP2 2.2R, geser SL ke entry setelah profit ≥ 0.6R (`BE_AT_R`, 0 = nonaktif). Event baru `BE` → app menampilkan peringatan geser SL.
- Angka-angka ini **belum dikalibrasi dengan data tick nyata** — jalankan `backtest.js --sweep` pada datamu.

## Perubahan v3

- **Live feed Binance**: utamakan `stream.binance.com` (vision sering OPEN lalu macet), failover multi-host, REST `bookTicker` fallback tiap 1s, stale watchdog.
- **Deriv**: timestamp dari `tick.epoch` (bukan hanya `Date.now()`), stale reconnect tanpa loop saat weekend.
- **Sinyal**: faktor `loc` mean-reversion diganti `brk` (pullback/breakout); gate HTF 15m; lantai |mom|/|trend|; sesi lebih ketat + skip 8 menit open.
- **Default mode**: `balanced` (terkalibrasi walk-forward EURUSDT). Tetap informational — uji demo dulu.

## Perubahan v2

- **Engine terpisah** (`engine.js`): logika yang sama dipakai live dan backtest.
- **Horizon sinyal = menit** (bar 1m, ATR, EMA 5/20, efficiency ratio, range 15m), bukan 1–5 detik. Sinyal detik habis sebelum order manual di MT5 terisi.
- **Faktor tidak lagi dobel-hitung**: RSI/EMA/slope/tick-rule semuanya turunan harga yang sama, jadi "4/4 searah" dulu sebenarnya satu sinyal. Order flow hanya dipakai bila ada (Binance), bobot kecil.
- **Normalisasi ATR** menggantikan pengali `gs` tebakan per pair.
- **Gerbang biaya**: ATR 1m harus ≥ 2.5–4× biaya (max(spread live, `typSpread`)).
- **Filter**: sesi per pair, pasar tutup (juga untuk Binance), spike volatilitas (ATR14 > 2.2× ATR60), choppy (ER), batas rugi harian 3R, cooldown lebih panjang setelah loss.
- **Bug**: timer konfirmasi tidak direset saat kondisi gugur (ENTRY bisa muncul tanpa konfirmasi); tombol SHOW STATS tidak pernah menampilkan apa pun; kalibrasi probabilitas tidak pernah terisi (kode mati); `hist.shift()` O(n) pada 100.000 tick; stale 2.5 dtk terlalu ketat untuk GBP/AUD di Binance.
- **Statistik dalam R** (expectancy, total R, profit factor, max DD) menggantikan "win rate" yang menghitung TP1 sebagai menang. Posisi: 50% ditutup di TP1, SL ke BE, sisanya ke TP2 / time-stop 45 menit.
- Storage key `fxSniper2` (riwayat lama tidak dimigrasi karena metriknya berbeda; saldo/risiko/offset MT5 dimigrasi).
- Panel "probabilitas" kini **Direction Bias** (skor −1…+1) — angkanya memang tidak pernah probabilitas terkalibrasi.

## Catatan jujur

Tidak ada versi kode yang bisa menjamin profit. Struktur SL 1R / TP1 1.0R / TP2 2.2R dengan BE punya expectancy 0 pada harga acak (sebelum biaya), jadi keuntungan hanya datang dari edge sinyal; pada random walk dengan spread 1 pip engine ini rugi sekitar −0.2R/trade, dan itulah biaya yang harus dikalahkan edge. Uji di akun demo ≥ 100 trade sebelum memakai uang nyata.
