# Mengukur Edge, Bukan Merasa Edge

**Panduan analisis & riset FX Majors Sniper** — metodologi, alat, konvensi data, dan batas yang tidak boleh dilewati.

Edisi 1 November 2026 · berkas sumber: `docs/ANALISIS.md` · bahan baku: `README.md` (log analisis proyek), `engine.js`, `backtest.js`, `tools/*.js`

---

## Siapa ebook ini untuk, dan apa yang TIDAK dia janjikan

Ebook ini untuk orang yang mau memeriksa, mengulang, atau melanjutkan riset sinyal di repo ini — bukan untuk mengoperasikan panel. Tidak ada satu halaman pun di sini yang berisi "setup yang profit". Justru sebaliknya: seluruh isinya adalah cara sampai pada kesimpulan bahwa, pada data yang tersedia sampai hari ini, **mesin sinyal ini tidak punya edge arah yang lebih besar daripada biaya round-trip**, dan cara memastikan kesimpulan itu tetap benar waktu datanya berubah.

Kalau kamu datang mencari angka yang bisa dipakai untuk mengirim order, baca Bagian 8 dulu. Bagian itu berisi daftar hal yang sengaja TIDAK kami lakukan demi mendapatkan angka tersebut — dan itu bagian paling berharga dari dokumen ini.

---

## Bagian 0 — Putusan satu halaman

**Pertanyaan.** Apakah keputusan arah (`UP`/`DOWN`) yang dihasilkan `engine.js` membawa informasi, pada horizon yang dia pakai (bar 15 menit), setelah biaya nyata broker retail?

**Jawaban singkat.** Tidak, pada semua pasangan yang diuji dan pada semua horizon yang diukur (15, 60, 180 menit), sampai data 12 bulan. Yang terukur adalah biaya 0,13–0,19 ATR per trade melawan |edge| ≤ 0,006 ATR — rasio 20–30×.

**Empat bukti yang menopangnya.**

- **`geoMiss = 0%` di 10 lintasan (4 pair × 2 mode, 1 600+ trade).** Tidak ada satu pun trade rugi yang sempat menyentuh +1R. Jadi sisi keluar (TP1/TP2/break-even/time-stop) bukan penyebab kerugian — tidak ada yang bisa diperbaiki di sana.
- **`mfeAvg` ≈ +0,29R vs `maeAvg` ≈ −0,33R, di semua pair.** Puncak profit dan puncak rugi hampir simetris dan keduanya kecil: bentuk khas tebakan arah tanpa informasi. `dirMiss` 50–61% menguatkan: lebih dari setengah loser tidak pernah lewat +0,5R.
- **88–93% penutupan adalah `TIME`.** Tesis plan kedaluwarsa, bukan terhenti di SL atau TP.
- **Walk-forward 4 fold, 97 kombinasi:** tidak ada satu pun konfigurasi positif di semua fold. Yang paling dekat pun masih `2/4 fold negatif`.

**Status produksi sebagai konsekuensinya.** `dryRun=true`, `autoArm=false`, tidak ada order live yang dikirim. Bukan karena koneksinya belum jadi — jalur order sudah terbukti bolak-balik ke terminal — tapi karena tidak ada yang layak dikirim.

**Satu-satunya hal yang berubah selama riset dan layak diingat.** Sinyal emas pernah kelihatan signifikan dengan tanda yang salah (−0,850 ATR, p=0,001 di 45 hari). Di data 12 bulan angka itu menguap jadi −0,006 dengan p=0,366. Hipotesis "balik saja sisi emas" mati oleh datanya sendiri, sebelum sempat masuk ke kode.

---

## Bagian 1 — Pertanyaan yang dijawab, dan yang sengaja tidak dijawab

Riset yang berantakan biasanya dimulai dari satu hal: pertanyaannya tidak pernah dibatasi. Ini daftar yang dipakai proyek ini.

**Yang dijawab.**

- Apakah arah sinyal membedakan dirinya dari nol? (→ `tools/signal_test.js`, uji hipotesis dengan bootstrap.)
- Kalau avgR negatif, yang salah di entry atau di exit? (→ MFE/MAE per trade, `geoMiss`/`dirMiss`.)
- Apakah kombinasi parameter tertentu punya edge yang bertahan out-of-sample? (→ `tools/calibrate.js` lalu `tools/walkforward.js`.)
- Seberapa besar biaya sesungguhnya, dan dalam satuan yang sama dengan yang dipakai terminal? (→ `costPips()`, rasio ATR/biaya, pagar spread EA.)
- Apakah sebuah gerbang benar-benar menjaga, atau cuma dekorasi? (→ ablasi gerbang di `signal_test.js`.)

**Yang tidak dijawab, dan jangan dikira dijawab.**

- Apakah strategi ini profitabel di akun dan spread kamu minggu depan. Yang terukur adalah dua jendela historis (45 hari dan 12 bulan) pada satu broker demo, dengan spread yang dipasang sebagai konstanta per pair.
- Apakah edge akan muncul di data masa depan. Semua temuan negatif di sini adalah pernyataan tentang data yang ada, bukan teorema.
- Apakah sisi keluar yang lebih pintar (trailing, partial lain) akan menolong. `geoMiss = 0%` sudah menjawab ini sebelum sempat diuji: posisi yang rugi tidak pernah mendekati TP1, jadi tidak ada sesuatu di exit untuk diperbaiki.

---

## Bagian 2 — Tangga pengukuran

Empat alat, empat pertanyaan yang berbeda. Urutannya bukan selera — setiap anak tangga menjawab pertanyaan yang tidak bisa dijawab anak tangga di bawahnya, dan setiap klaim harus naik sampai anak tangga yang benar sebelum boleh dipercaya.

**Tangga 1 — `backtest.js`: "berapa hasil geometri ini di data ini?"**
Simulasi penuh: sinyal → SL/TP/BE/time-stop → `resultR`. Cepat, dan karena itu paling mudah menipu. Angka tunggal (`avgR`, PF) tidak memberi tahu di mana loss terjadi. Jalankan dengan `--sweep` untuk grid dan `--split 0.6` untuk TRAIN/TEST.

**Tangga 2 — `tools/calibrate.js`: "apakah ada konfigurasi yang lebih baik, tanpa mencurangi TEST?"**
Pencarian koordinat greedy di TRAIN (60%) dengan **satu** validasi di TEST (40%). Evaluasi tiap 5 dtk, `MIN_POOL` 40 trade dan `MIN_EACH` 3 trade per sisi. Yang disapu: `BAR_MIN` (1/3/5/15 m), `minScore`, `minER`, `minCost`, `persist`, `cooldown`, `SL_ATR_MULT`, `TP1_R`, `TP2_R`, `MIN_MOM`/`MIN_TREND`, `HTF_SOFT`, `BRK_CEIL`. Aturan baca: percaya hanya konfigurasi yang positif di TEST (n ≥ 30, PF > 1,1) **dan** berada di plateau, bukan di puncak tajam.

**Tangga 3 — `tools/walkforward.js`: "apakah ia bertahan di setiap potongan waktu?"**
Fold bergerak-maju (`--folds`, default 4), tiap kombinasi di worker terpisah, dinilai dari **fold terburuk** — bukan agregat. Ini alat yang menghukum kurva-fit: konfigurasi yang hijau di satu potongan TEST tapi merah di fold lain otomatis gugur.

**Tangga 4 — `tools/signal_test.js`: "apakah ARAH itu sendiri membawa informasi?"**
Konsep dipinjam dari jesse-ai/jesse (MIT): jalankan keputusan arah **tanpa** mensimulasikan posisi, nilai tiap sinyal dengan return maju yang di-detrend, lalu bandingkan dengan nol lewat **stationary block bootstrap** (Politis–Romano, blok geometris) supaya korelasi serial tidak menyamar jadi edge. Horizon diatur `--horizon`, jarak antar sampel `--stride` (set `--stride` sama dengan `--horizon` supaya jendela tidak tumpang tindih), dan gerbang bisa dilepas satu per satu untuk ablasi.

Tangga ini juga menentukan **klaim apa yang boleh ditulis dengan alat apa**. "TOP 8 di TRAIN" adalah kalimat untuk tangga 1. "Tidak terbedakan dari nol dengan n=32 836 sampel" adalah kalimat untuk tangga 4. Mencampur keduanya — misalnya menjual angka TRAIN sebagai hasil — adalah kegagalan metodologi, bukan kegagalan strategi.

---

## Bagian 3 — Data dan konvensinya

### 3.1 Bagaimana datanya dibuat

```bash
node tools/fetch_klines.js EURUSDT PAXGUSDT BTCUSDT ETHUSDT --days=45
node tools/fetch_klines.js PAXGUSDT BTCUSDT --days=365
```

Klines 1 menit dari REST publik Binance (tanpa key; host failover `data-api.binance.vision` → `api.binance.com`), ditulis ke `data/<SYM>_1m.csv` berformat `ts,bid,ask`. **Satu bar 1 menit diubah jadi 4 titik harga** — `o` → (`h` atau `l` dulu, ikut arah bar) → sisa → `c` — dengan jarak 15 detik. Jadi 45 hari = 259 200 baris 15 dtk per aset; 365 hari untuk dua aset = 525 605 bar 1m.

Dua konsekuensi yang harus diterima sejak awal:

- **Ini bukan data broker.** Yang diukur adalah struktur harga Binance USDT/PAXG dengan spread yang **kita pasang sendiri**.
- **`--days` memakai tanda `=`.** `tools/fetch_klines.js` membaca flag sebagai `--days=N`; bentuk `--days 90` akan diam-diam jatuh ke default 30. (Catatan ini ada karena kami pernah melakukannya.)

### 3.2 Spread sintetis adalah bagian dari metode, bukan kompromi

Spread dipasang **konstan = `typSpread` pair di `engine.js`** — biaya broker retail FBS-Demo (XAUUSD 4,5 pip, BTCUSD 20 pip, EURUSD 2,8 pip), **bukan** spread Binance yang jauh lebih tipis. Mid-nya diletakkan di harga Binance, jadi sinyal identik dan hanya biaya yang nyata. Alasannya: `costPips()` memakai `Math.max((ask-bid)/P.pip, P.typSpread)`, jadi kalau datanya pakai spread Binance, audit biaya R4/`minCost`/pagar EA akan optimistis palsu.

Ini juga yang membuat eksperimen "+1,16 R" jadi mungkin (lihat 7.1): menulis ulang CSV dengan spread FBS 2,8 pip, tanpa mengubah mid, mengubah kesimpulan dari "profit" jadi "nol trade".

### 3.3 Satuan: sumber bug paling mahal di repo ini

**Poin broker = `10^-dp`, bukan `pip/100`.** Ada dua helper di `bridge/server.js` (`pointOf`/`pointsPerPip` di sekitar baris 322) dan keduanya harus dipakai:

| pair | `pip` | `dp` | poin broker | points per pip |
|---|---|---|---|---|
| EURUSD | 0.0001 | 5 | 0.00001 | 10 |
| XAUUSD | 0.1 | 2 | 0.01 | 10 |
| BTCUSD | 1 | 2 | 0.01 | 100 |

Untuk BTC, `pip/100` dan `10^-dp` kebetulan sama — jadi uji yang hanya memakai BTC **tidak akan pernah menemukan** kesalahan satuan, sementara EURUSD dan XAUUSD melenceng 10×. Itu persis bug yang terjadi pada feed cadangan: `point = pip/100` membuat spread EURUSD terbaca 280 points padahal EA melaporkan 28. Sekarang dikunci oleh §J di `tools/scanner_test.js` dengan empat pair sekaligus.

Aturan praktisnya: apa pun yang dibandingkan dengan `spreadPts`/`atrPts` dari `sniper_status.txt` harus berada dalam **points broker**, dan apa pun yang dibandingkan dengan `minCost`/`typSpread` harus dalam **pips**. Konversi di salah satu sisi akan menghasilkan "zona mati" atau "kelulusan" yang murni aritmetika.

### 3.4 ATR: horizon harus sama dengan horizon EA

EA memakai `InAtrTF = PERIOD_M15`. Feed cadangan dan semua pemeriksaan biaya harus memakai **ATR(14) atas bucket 15 menit** — bucket yang masih berjalan dibuang, dan kalau bar < 20 hasilnya 0 (jangan sampai `minCost` membagi dengan nol). Dengan ATR 1 menit, R4 akan menolak dengan biaya palsu. Pada `tools/fetch_klines.js`, baris 1 menit memang ada; yang wajib adalah agregasi ke 15 menit sebelum dihitung.

### 3.5 Direktori data

`data/` berisi CSV aktif; salinan 45 hari lama ada di `data/archive_45d/` supaya hasil lama tetap bisa direproduksi; potongan setengah tahun di `data/PAXG_1H.csv` / `PAXG_2H.csv`. **Jangan menimpa salinan** — seluruh klaim "dulu bilang X, sekarang bilang Y" bergantung pada bisa menjalankan ulang yang lama.

---

## Bagian 4 — Anggaran biaya

Semua keputusan di proyek ini jatuh di sini, jadi bagian ini ditulis paling detail.

### 4.1 Biaya satu round-trip

```
costPips() = Math.max((ask - bid) / P.pip, P.typSpread) + COST_EXTRA_PIPS
```

`PARAMS.COST_EXTRA_PIPS` adalah slippage + komisi **round-trip** dalam pips. Default 0 = perilaku lama (hanya spread), dan itu sengaja: angka live tidak boleh berubah diam-diam. Untuk akun raw/commission, kolom ini **wajib** diisi. `COST_EXTRA_PIPS` bukan cuma dipakai untuk audit — saat posisi ditutup, dia juga dipotong dari `resultR` (`finish()` di `engine.js:252`), supaya `dayR` dan `lossStreak` memakai yang bersih.

### 4.2 Gerbang biaya per mode

`minCost` dibaca sebagai: **ATR(pips) ≥ `minCost` × biaya(pips)**. Nilai sekarang (`engine.js:78`):

| mode | minScore | minER | **minCost** | persist | cooldown |
|---|---|---|---|---|---|
| precision | 0,55 | 0,36 | **4,0** | 30 s | 25 mnt |
| balanced | 0,48 | 0,32 | **3,5** | 20 s | 15 mnt |
| agresif | 0,42 | 0,26 | **2,0** | 8 s | 8 mnt |
| momentum | 0,44 | 0,28 | **3,2** | 15 s | 12 mnt |
| liquidity | 0,48 | 0,32 | **3,5** | 20 s | 18 mnt |
| auto | 0,58 | 0,38 | **4,0** | 30 s | 30 mnt |
| edge | 0,65 | 0,42 | **4,5** | 40 s | 45 mnt |

**`agresif` bukan mode yang lebih terbukti.** Ia ditambahkan 3-11-2026 setelah `tools/_fx_funnel.js`
menunjukkan bahwa major FX nyaris tidak pernah lolos gerbang biaya: EURUSD 0,013% evaluasi, GBP/USD,
USD/CHF, AUD/USD, USD/CAD, NZD/USD 0,000%, USD/JPY 0,071% pada 45 hari data replay. Penyebab utamanya
bukan sinyal, tapi asumsi biaya: `typSpread` lama 2,8–4,5 pips vs spread akun terukur 0,90–1,20 pips.
Karena itu dua hal diubah bersamaan: `typSpread` major diturunkan ke 1,2–1,5 pips (emas 3,0; crypto
tetap 20) **dan** `agresif` ditambahkan sebagai pilihan eksplisit. `agresif` sengaja melewati
`calib.modeFloor` EUR/XAU/ETH; kalau tidak, lantai `minCost:4.0` akan mengembalikannya ke balanced.
Konsekuensi yang harus dibaca: `minCost:2.0` berada di bawah pagar EA 4,0, jadi sinyal dashboard bisa
ditolak AUTO-ORDER saat spread nyata > 25% ATR. Mode ini untuk melihat/menguji sinyal, bukan klaim edge.
Replay lama tetap konservatif karena CSV menyimpan spread lama dan `costPips()` memakai `Math.max`.

### 4.3 Pagar spread di terminal, dan zona mati yang pernah tercipta oleh keduanya

EA menolak order kalau `spread > maks(InMaxSpreadPoints, InMaxSpreadAtrPct% × ATR)`. Scanner sekarang **meniru rumus yang sama sebelum** memanggil `submit()` (`eaSpreadCap()` di `bridge/scanner.js:36-37`, `EA_SPREAD_FLOOR_PTS = 30`, `EA_SPREAD_ATR_PCT = 25`), memakai points broker sehingga lantainya ikut sama.

Sejarah yang penting untuk dipahami, karena berulang kali menggoda:

- Dengan `InMaxSpreadAtrPct = 15`, EA menuntut **ATR/spread ≥ 6,67×**, sementara pakar meloloskan pada **≥ 2,4×**. Semua yang jatuh di antara 2,4× dan 6,67× dinyatakan layak lalu dibuang sebelum sempat ditulis. BTCUSD persis di tengah zona itu hari itu: spread 1965 pts vs plafon 1736 pts. Akibatnya bukan nasib buruk — 8 order tercatat sebagai `sent 8 • diterima 4 • ditolak 4 • open 0`, dan itu konsekuensi aritmetika dua ambang yang tidak pernah dicocokkan.
- Sekarang diselaraskan ke 25% ⇒ **≥ 4,0×**, sama dengan `minCost` mode precision/auto. Konsekuensinya dicatat agar tidak "diperbaiki" oleh orang lain: pada mode ber-`minCost` < 4 (balanced 3,5 / momentum 3,2 / liquidity 3,5) mesin masih bisa meloloskan sesuatu yang pagar EA buang. Zona mati tidak hilang, hanya menyempit.
- Angka 30 pts dan 25% kini hidup di **dua tempat** (`mt5/SniperBridge.mq5` dan `bridge/scanner.js`). Kalau salah satunya diubah di chart, salinan di scanner harus diubah juga.

### 4.4 Rasio biaya live — angka yang menyempitkan semesta

Diukur dari `sniper_status.txt` (ATR/spread) pada satu sesi sore:

| pair | ATR/biaya | verdict |
|---|---|---|
| XAUUSD | **16,6×** | lolos |
| BTCUSD | **4,12×** | lolos |
| EURUSD | 1,89 | gagal |
| USDJPY | 1,84 | gagal |
| ETHUSD | 1,44 | gagal |
| GBPUSD | 1,14 | gagal |
| USDCAD | 1,12 | gagal |
| USDCHF | 1,04 | gagal |
| NZDUSD | 0,82 | gagal |
| AUDUSD | 0,72 | gagal |

FX major di FBS punya spread ±2,8 pip melawan ATR(M15) ±5,3 pip. Mereka **tidak akan pernah** memenuhi syarat biaya apa pun di atas 2,0×. Ini bukan opini tentang sinyal FX major: pertanyaannya bahkan belum sampai ke sana. Karena itu riset sinyal difokuskan ke dua simbol yang secara biaya boleh dibuka, dan `EURUSDT`/`ETHUSDT` memang tidak ikut di-fetch ulang ke 12 bulan.

---

## Bagian 5 — Metrik, dan cara membacanya

**`avgR`, `PF`, `n`.** Hasil rata-rata dalam satuan R, profit factor, jumlah trade. Tidak ada yang boleh disimpulkan tanpa `n` dan tanpa tahu berapa banyak exit yang `TIME`.

**MFE / MAE (per trade, dalam R, diukur di harga sisi keluar sehingga sudah termasuk spread).** `mfe` = puncak profit, `mae` = puncak rugi. Dari sini `summarize()` menurunkan dua diagnosis yang mengubah arah riset:

- **`geoMiss`** = rugi padahal pernah ≥ 1R → **salah keluar**. `geoMiss = 0%` berarti sisi exit tidak bersalah.
- **`dirMiss`** = rugi tanpa pernah melewati +0,5R → **salah arah**. Nilai 50–61% adalah wilayah "tidak lebih baik dari undian".

**Ukuran kualitas lain** (juga lewat `backtest.js`, blok "Ukuran kualitas"): `winLossRatio`, `upsPct`/`winUp`/`winDown`, `holdWin`/`holdLoss`, `sharpe`/`smartSharpe`. Contoh pembacaannya, XAUUSD balanced: 63% UP dengan win 39,7% vs DOWN 38,2% (asimetri nyata tapi kecil), tahan menang 60 mnt vs rugi 59 mnt ⇒ **tidak ada bias hold-loser**, dan hukuman serial hanya 1,08× ⇒ Sharpe tidak sedang ditopang trade yang berdempetan.

**Edge di `signal_test.js` dinyatakan dalam ATR**, bukan pips atau R: drift jendela maju yang sudah di-detrend, dibagi ATR. Ini yang membuatnya bisa dibandingkan antar pair — dan sekaligus membuat "edge +0,13 ATR" bisa langsung dikonfrontasikan dengan "drag spread −0,19 ATR" di baris yang sama.

**`p` dari stationary block bootstrap.** Ambang baca: **p ≥ 0,05 = arah tidak bisa dibedakan dari nol**, dan pada titik itu tidak ada gunanya menyetel SL/TP/biaya lagi — itu cuma memindah-mindahkan rugi. Bootstrap (bukan iid) dipakai karena return intraday berkorelasi serial; resampling iid akan membuat noise tampak signifikan.

**Dua kontrol wajib sebelum percaya apa pun.** Alat ini menguji dirinya sendiri di setiap lintasan:

- **`nabi`** — arah = tanda return yang *sudah terjadi*. Harus **tertangkep**: p=0,000 dengan edge +0,49…+0,69 ATR (45 hari) dan +2,3…+2,6 ATR (12 bulan). Kalau ini lolos, alatnya tumpul dan semua "✘ tidak terbedakan" tidak berarti apa-apa.
- **`koin`** — arah undian. Harus **lolos**: p=0,55…0,83 (45 hari), p=0,87 (12 bulan).

Karena kedua kontrol itu lulus di semua lintasan, kalimat "tidak terbedakan dari nol" adalah sifat datanya, bukan sifat alatnya.

---

## Bagian 6 — Resep reproduksi

Semua perintah di bawah sudah dijalankan di lingkungan ini; jalankan dari root repo.

```bash
# 0) regression dulu — sebelum membaca angka apa pun
node tools/bridge_test.js          # 91 assertion
node tools/scanner_test.js         # 70 assertion (termasuk satuan feed & jalur paper)
node tools/bridge_http_test.js     # 37 assertion
node tools/ea_sim.js               # 11 langkah, jalur plan -> order -> ack
node tools/latch_test.js
node tools/ui_smoke.js             # DOM/WS stub; exit 0 = bersih

# 1) data
node tools/fetch_klines.js PAXGUSDT BTCUSDT --days=365

# 2) tangga 1-2: grid + kalibrasi (TRAIN 60% / TEST 40%)
node backtest.js data/XAUUSD_1m.csv --pair XAUUSD --mode balanced --sweep --split 0.6
node backtest.js data/BTCUSD_1m.csv --pair BTCUSD --mode momentum --cost-extra 1.5
node tools/calibrate.js            # 4 worker, satu aset per worker (RAM)
node tools/calibrate.js --report   # evaluasi ulang config default tanpa pencarian

# 3) tangga 3: fold bergerak, dinilai dari fold terburuk
node tools/walkforward.js data/XAUUSD_1m.csv --pair XAUUSD --folds 4 --eval 5000

# 4) tangga 4: apakah ARAH membawa informasi (tanpa SL/TP/BE sama sekali)
node tools/signal_test.js data/XAUUSD_1m.csv --pair XAUUSD --horizon 15 --stride 15 --eval 120000
node tools/signal_test.js data/BTCUSD_1m.csv --pair BTCUSD --horizon 180 --stride 180 --eval 300000
node tools/signal_test.js data/PAXG_1H.csv --pair XAUUSD --horizon 180 --stride 180 --boot 3000
```

Tiga kebiasaan yang membuat hasil bisa dipercaya, bukan cuma bisa dijalankan:

1. **`--seed` di `signal_test.js`** (default 7). Bootstrap itu sampling; tanpa seed, dua orang akan melaporkan angka berbeda dan tidak ada yang bisa menyalahkan yang lain.
2. **`--stride` = `--horizon`.** Kalau tidak, jendela prediksi tumpang tindih dan `n` membengkak palsu — tenaga statistik yang kamu klaim tidak ada.
3. **Ukuran sampel ditulis bersama kesimpulannya.** "n=14, 12 dari 14 exit adalah TIME" bukan catatan kaki; itu isi klaimnya.

---

## Bagian 7 — Hasil, dan apa yang gugur oleh hasilnya

### 7.1 45 hari: sapuan, kalibrasi, dan artefak biaya

Sweep 81 kombinasi (EURUSD, XAUUSD; split 60/40, evaluasi tiap 5 dtk) plus walk-forward 97 kombinasi × 4 fold:

- **Tidak ada satu pun kombinasi positif di TRAIN.** "TOP 8 di TRAIN" EURUSD dimulai dari `avgR −0,010` (n=32, PF 0,94); XAUUSD `−0,010 … −0,037`. TRAIN yang sudah negatif membuat TEST yang positif (EURUSD #5–#8: `n=41 avgR +0,035 PF 1,24`) otomatis tidak berarti — itu pola klasik kurva-fit.
- **Satu-satunya angka positif yang pernah muncul — +1,16 R, PF 1,07, n=103 (momentum/EURUSD) — adalah artefak biaya.** CSV-nya memakai `typSpread` Binance 1 pip, padahal FBS memungut ±2,8 pip di simbol yang sama. Dengan spread dinaikkan ke 2,8 pip (mid tidak diubah, jadi sinyalnya identik dan hanya biaya eksekusinya yang nyata — `/tmp/EURUSD_fbs.csv`), **kedua mode menghasilkan n = 0**: nol trade, bukan rugi. Penyebabnya 1,89× ATR/spread vs `minCost` berapa pun. Artinya angka itu sebenarnya "profit kalau biaya hampir tidak ada".
- **Emas dan BTC tidak bisa dibuang dengan alasan biaya.** Di sana ATR/biaya besar (16,6× dan 5,7× di terminal), sinyalnya memang lolos audit biaya — dan hasilnya tetap minus: balanced penuh XAUUSD −4,31 R, BTCUSD −17,59 R. Jadi kesimpulannya bukan "biayanya kemahalan", tapi "mesin sinyalnya tidak punya edge yang menutupi biaya".
- **Walk-forward: tidak ada konfigurasi positif di semua fold.** Paling dekat pun `2/4 fold negatif`. EURUSD terbaik: TRAIN −0,003 R; TEST per fold `22tr/+0,019 · 18tr/−0,049 · 20tr/+0,163 · 20tr/−0,053` (agregat +1,76 R atas 80 trade). XAUUSD: TRAIN −0,136 R, agregat TEST −0,01 R. Potongan test per fold ±9 hari = 3–22 trade — jadi ini "pada 45 hari ini, tidak", bukan "terbukti tidak ada edge selamanya".

### 7.2 45 hari: diagnosis MFE/MAE

10 lintasan, 1 600+ trade, seragam sampai mencurigakan:

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

Yang boleh disimpulkan: **yang bermasalah adalah arah/filtered entry, bukan exit, dan bukan (semata-mata) biaya.** Sensitivitas biaya juga terukur, bukan diasumsikan: XAUUSD `--cost-extra 1.5` (spread CSV 3 pips vs FBS 4,5) menggeser totalR −4,31 → −4,90, ≈ −0,006 R per trade — nyata tapi bukan penjelas utama. Untuk EURUSD justru murni biaya: dengan spread yang benar n jadi 0, dan `--cost-extra 0.5` di atas data FBS itu tetap 0 trade.

Sisa winner (exit `TP2`) punya mfe 2,3–2,5R dengan mae −0,1…−0,2R: saat arahnya benar, ia benar sejak awal dan tidak pernah melihat ke bawah. Sampel kecil ini tidak boleh diperbesar-besarkan jadi "kalau filter diperketat akan profit".

### 7.3 45 hari: uji sinyal, dan satu-satunya hal yang kelihatan hidup

Edge dalam ATR, detrend global, 4 305 sampel tidak tumpang tindih pada jendela 15 mnt:

| pair | SEMUA sinyal 15 mnt | 60 mnt | setelah gerbang (15 mnt) | drag spread |
|---|---|---|---|---|
| EURUSD | −0,006 • p=0,58 | +0,025 • p=0,59 | +0,015 • p=0,79 (n=181) | −0,28 ATR |
| XAUUSD | **−0,045 • p=0,010** | **−0,206 • p=0,006** | −0,098 • p=0,23 (n=182) | −0,17 ATR |
| BTCUSD | −0,005 • p=0,70 | −0,010 • p=0,85 | −0,030 • p=0,74 (n=295) | −0,14 ATR |
| ETHUSD | +0,006 • p=0,62 | +0,030 • p=0,56 | −0,068 • p=0,72 (n=281) | −0,23 ATR |

Di 180 menit (stride = horizon), efek emas itu **membesar**: XAUUSD −0,056 (p=0,001) / −0,192 (p=0,008) / **−0,850 ATR (p=0,001, n=358)**; BTCUSD datar di nol pada ketiga horizon (−0,001 / −0,022 / −0,042). Sisi per sisi di 180 mnt: UP −0,635 (n=159) dan DOWN −1,023 (n=199) — keduanya negatif, jadi ini mesin yang berdiri di sisi yang salah, bukan artefak satu 45 hari di mana emas hanya turun.

**Ablasi gerbang meninggalkan satu pertentangan yang harus diselesaikan, bukan dipilih.** Melepas `BRK_CEIL` ("di ekstrem range 15m — tunggu pullback") paling memperbaiki edge di 45 hari (EURUSD 0,004 → 0,043; XAUUSD −0,098 → −0,018), padahal sweep bilang memperketatnya 0,88 → 0,75 menaikkan avgR. Keduanya bisa benar karena avgR diukur sesudah geometri keluar dan biaya, sedangkan signal_test mengukur drift mentah. Pertentangan ini diselesaikan di 7.5.

### 7.4 Hipotesis yang diuji dan jatuh

Angka −0,850 ATR p=0,001 itu menggodai: tinggal balik sisi emas. Yang dilakukan justru langkah yang membosankan — ambil data yang belum pernah dilihat, karena itulah yang membedakan "saya menemukan edge" dari "saya menghafal noise".

`tools/fetch_klines.js PAXGUSDT BTCUSDT --days=365` (525 605 bar 1m, 2025-10-31 → 2026-10-31, spread dipasang `typSpread` FBS 4,5/20 pips seperti sebelumnya), lalu `signal_test.js --horizon 180 --stride 180 --eval 300000`:

| jendela XAUUSD (180 mnt) | n | edge | p | tanda |
|---|---|---|---|---|
| 45 hari (Bagian 7.3) | 358 | **−0,850 ATR** | 0,001 | salah arah |
| setengah tahun I (2025-11 → 2026-04) | 1 458 | **+0,178 ATR** | 0,092 | benar arah, tak terbedakan |
| setengah tahun II (2026-04 → 2026-10) | 1 458 | **−0,052 ATR** | 0,642 | tak terbedakan |
| BTCUSD setahun penuh | 2 918 | +0,028 ATR | 0,639 | tak terbedakan (UP +0,050 / DOWN +0,006) |

**Tandanya berpindah antar-paruh dan tidak ada satu pun yang signifikan di 5%.** Angka yang paling menggodai di log ini adalah sifat 45 hari itu, bukan sifat mesin maupun sifat emas. Kontrol alat tetap lulus di tiap lintasan (`nabi` +2,3…+2,6 ATR p=0,000; `koin` p=0,87) di 1 458–2 918 sampel non-overlapping — jadi "tidak terbedakan dari nol" diucapkan dengan tenaga statistik yang memadai, bukan dengan sampel kecil. Fade XAUUSD tidak diimplementasikan, dan tidak akan, kecuali suatu ketika muncul positif di **SEMUA** fold dengan n ≥ 30 per fold. Tidak ada satu baris pun `engine.js` yang diubah untuk inversion ini.

### 7.5 Verifikasi penutup: 15 menit pada tahun yang sama

15 menit adalah horizon yang dipakai mesin, jadi ia harus diuji di sana — bukan hanya di 180 menit yang kebetulan paling dramatis. `--horizon 15 --stride 15 --eval 120000`: **32 836 sampel tidak tumpang tindih per pair**, ≈10× tenaga statistik 45 hari; pita nol 95%-nya menyempit ke ±0,013 ATR, jadi efek sekecil 0,045 yang dulu "signifikan" itu sekarang **harus** kelihatan kalau memang ada.

| 15 menit, 365 hari | n | edge kotor | p | drag spread | setelah biaya |
|---|---|---|---|---|---|
| XAUUSD — semua sinyal | 32 836 | −0,006 | 0,366 | **−0,188** | −0,194 |
| XAUUSD — lolos semua gerbang | 135 | +0,127 | 0,093 | −0,081 | +0,046 |
| BTCUSD — semua sinyal | 32 837 | −0,002 | 0,668 | **−0,127** | −0,129 |
| BTCUSD — lolos semua gerbang | 161 | +0,028 | 0,637 | −0,101 | −0,073 |

- **Drag tetap dominan, dan sekarang terukur dengan sampel yang layak.** Pada seluruh sinyal, |edge| ≤ 0,006 ATR lawan drag 0,127–0,188 ATR: rasionya 20–30×, bukan 2×. Kombinasi 60 + 180 + 15 menit semuanya bilang hal yang sama.
- **Satu-satunya sisi yang pernah tampak hidup adalah subset yang lolos gerbang** (XAU +0,127 kotor / +0,046 bersih, n=135). Ia diperiksa dengan cara yang sama seperti klaim sebelumnya dan **gagal lagi**: paruh I `n=93 edge +0,176 p=0,040`, paruh II `n=40 edge −0,032 p=0,759`. Tanda berpindah antar-paruh untuk ketiga kalinya di data ini. Tidak ada yang di-arm.
- **Drag-nya sendiri bukan konstanta, dan bergerak ke arah yang salah.** Paruh I −0,142 ATR vs paruh II −0,234 ATR. Asumsinya spread 4,5 pip konstan; yang berubah adalah ATR-nya (mengecil), jadi 6 bulan terakhir justru **lebih sedikit** layak ditrade-kan, bukan lebih banyak. Ini alasan kedua — setelah "tidak ada edge" — mengapa ambang biaya tidak boleh diturunkan untuk "mencari sesuatu".
- **Yang justru terverifikasi positif: `BRK_CEIL`.** Pertentangan 7.3 selesai **ke arah sweep** pada sampel yang lebih besar: melepas `Brk ceil` di setahun menurunkan edge XAUUSD 0,127 → 0,015 (Δ −0,112; di tabel ablasi, Δ negatif = gerbang berguna). `Skor` (−0,091) dan `ER` (−0,074) juga berguna. Satu-satunya Δ positif adalah `ATR/biaya` sendiri (+0,031): dia memang menahan sinyal yang drift-nya lebih baik — tapi gerbang biaya (bersama `Skor`/`ER`/`Brk ceil`) itulah yang menurunkan drag dari −0,188 ke −0,081, dan menukar 0,03 ATR drift dengan 0,10 ATR biaya adalah tukar yang benar untuk mesin yang hidup dari selisih kecil.
- **Tujuh gerbang tidak pernah menolak satu pun sampel dalam setahun** (`Mom&trend searah`, `Brk floor`, `flow`, `z jangan kejar`, `SL swing valid`, `spread`, `spike`; kolom "hilang" = kolom "n lolos"). Itu kandidat dekorasi, bukan penjaga — dan itu belum berubah. Menghapus salah satunya tidak akan mengubah perilaku mesin apa pun, jadi jangan menjadikannya "bukti" bahwa filter penting.

### 7.6 Kesimpulan operasional

**Dua simbol yang secara biaya boleh ditrade-kan (XAUUSD, BTCUSD) tidak membawa informasi arah pada horizon 15, 60, maupun 180 menit — termasuk pada data setahun.** FX major tidak sempat diuji setahun karena tersingkir lebih awal: dengan spread FBS ±2,8 pip vs ATR(M15) ±5,3 pip (1,9×) jumlah trade-nya 0 di mode mana pun, jadi pertanyaannya bukan lagi "sinyalnya bagus atau tidak" tapi "biayanya tidak akan pernah tertutup". Tidak ada konfigurasi gerbang/exit yang bisa mengubah salah satunya, karena `geoMiss = 0%` sudah menutup sisi exit.

Bridge tetap `dryRun` bukan karena perbaikannya belum selesai. Koneksi ke terminal sudah terbukti: status 1 dtk, ack bolak-balik, §C/§F/§G/§I hijau, order nyata `ok=1 ticket=2122418796` di akun DEMO FBS, partial close 50% dan TIME-STOP teramati di terminal asli. Yang belum terbukti hanyalah sinyalnya.

---

## Bagian 8 — Batas yang tidak boleh dilewati

Bagian ini adalah isi sebenarnya dari ebook ini. Semua item di bawah **terjadi**, dalam arti ada godaannya dan ada keputusannya.

**1. Jangan turunkan ambang supaya sweep menemukan sesuatu.** `minCost`/`minScore`/`minER` tidak diturunkan demi angka, dan fold validation tetap menilai dari fold terburuk. Ini satu-satunya aturan yang langsung mengubah "hasil negatif" menjadi "hasil yang berarti".

**2. Jangan balik sinyal yang signifikan di data yang sama.** "Saya menemukan edge dengan membalik di data yang sudah dilihat" adalah persis klaim yang dihukum walk-forward. Aturan bacanya: suatu inversion boleh dipertimbangkan hanya kalau ia **positif di SEMUA fold dengan n ≥ 30 per fold**, di horizon yang cocok, dengan gerbang dan geometri keluar yang dikalibrasi ulang untuk horizon itu — bukan gerbang 15 menit plus sisi dibalik.

**3. TRAIN yang negatif membuat TEST yang positif tidak berarti.** `n=41 avgR +0,035 PF 1,24` di TEST tidak pernah berdiri sendiri waktu seluruh ruang TRAIN di bawah nol.

**4. Jangan klaim "terbukti tidak ada edge selamanya".** Yang diukur adalah 45 hari dan 12 bulan pada satu broker demo dengan spread konstan. Batasi klaim pada jendela yang diukur — itu bukan kerendahan hati, itu akurasi.

**5. Kontrol alat sebelum kontrol data.** `nabi` harus tertangkap dan `koin` harus lolos, di setiap lintasan. Tanpa itu, "tidak signifikan" bisa berarti "alatnya tumpul".

**6. Gerbang yang tidak pernah menolak sesuatu bukan penjaga.** Laporkan sebagai dekorasi, dan jangan jadikan alasan optimisme.

**7. Jangan bandingkan angka lintas satuan.** Points broker vs pips adalah bug 10× yang sudah terjadi dan sudah pernah menyembunyikan zona mati. Lihat 3.3.

**8. Jangan pakai angka yang diukur dengan biaya palsu.** Setiap kali edge positif muncul, pertanyaan pertama adalah "spread apa yang dipakai data ini?".

**9. Selesaikan pertentangan, jangan pilih yang enak.** `BRK_CEIL` dibiarkan menggantung satu sesi penuh sampai ada sampel yang cukup untuk memutuskan. Kesimpulan akhirnya bahkan berlawanan dengan angka yang paling menarik di 45 hari.

**10. Jangan adopsi sistem, adopsi metode.** Dua repo ditolak dengan alasan yang sama. trade-ai (Python/Flask/SQLite/EC2 + satu otak order terpisah di atas akun yang sama) ditolak sebagai sistem — dua penulis, satu kebenaran — tapi **excursion per trade** dan **biaya eksplisit di luar spread** diadopsi. jesse-ai/jesse (MIT) ditolak sebagai port (dia ikut dimuat browser lewat `app.js`; memportasinya hanya mengganti satu sumber-kebenaran dengan dua), tapi **signal-only test dengan stationary block bootstrap**, konsep **filters sebagai predikat bernama** (dipakai terbalik jadi ablasi), dan **ukuran kualitas yang tidak bergantung rata-rata R** diadopsi. Yang tidak ada di jesse dan tidak kita kehilangan: grep `slippage` di seluruh repo = nol, tidak ada walk-forward, tidak ada MFE/MAE.

**11. Perubahan instrumentasi tidak boleh dibaca sebagai perubahan perilaku.** Ketika anomali jam 16:15–16:18 tidak bisa direkonstruksi, yang ditambah adalah jejak peristiwa (cincin 40 event di `info().events`) — bukan "mari kita ubah guard". Sebaliknya, baris `rearm` yang ternyata palsu (scanner mencatat pelepasan untuk `planId` yang tidak pernah dipegang engine mana pun) harus dikoreksi di catatan, bukan dibiarkan jadi bukti.

---

## Bagian 9 — Cara melaporkan temuan

Format yang dipakai `README.md` dan yang sebaiknya dipakai siapa pun yang melanjutkan riset ini. Setiap entri log:

**Klaim → bukti → apa yang BUKAN bukti → status.**

Contoh konkret dari Bagian 7.4: klaimnya "sinyal emas adalah anti-sinyal"; buktinya tabel 45 hari dengan kontrol `nabi`/`koin`; yang bukan bukti adalah signifikansi itu sendiri, karena ia ditemukan di jendela yang sama dengan semua penolakan kalibrasi sebelumnya; statusnya "hipotesis, wajib diuji out-of-sample". Setelah data 12 bulan: klaim dicabut, dan pencabutan itu tetap ditulis.

Empat kebiasaan yang membuat format ini berguna:

- **Tulis angka persis beserta n dan p-nya.** "XAUUSD −0,850 ATR p=0,001 n=358", bukan "emas kelihatan kuat".
- **Tulis yang tidak berubah.** "Tidak ada satu baris pun `engine.js` yang diubah untuk inversion ini" adalah kalimat yang membuat orang berikutnya percaya bahwa tidak ada backfill diam-diam.
- **Tulis kegagalan alat ukurnya.** Exit code 1 tanpa alasan di `tools/ui_smoke.js` pernah menyembunyikan assertion yang tidak mungkin lulus sejak ditulis — dan "0 error runtime" yang dikutip di README tetap benar waktu seluruh pemeriksaan isi panel gagal di belakangnya.
- **Tulis status produksi saat entri dibuat.** `dryRun=true`, `autoArm=false`, pasar tutup, terminal hidup/mati. Tanpa itu, orang berikutnya tidak tahu apakah ia membaca regresi atau cuaca.

---

## Bagian 10 — Apa yang masih terbuka

**Data.** Satu-satunya jalan melanjutkan pertanyaan "apakah ada edge" adalah horizon yang lebih panjang lagi dan aset yang belum disentuh, lalu fold bergerak di horizon yang sama. Yang sudah tertutup dan tidak perlu dibuka ulang dengan alat yang sama: exit-side (`geoMiss = 0%`), dan empat horizon intraday untuk dua simbol yang lolos biaya.

**Filter yang diukur dengan cara lain.** Semua yang diukur di sini menilai arah dengan drift yang di-detrend. Belum diukur: apakah fitur `mom`/`trend`/`htf`/`er`/`loc` punya daya beda pada **conditional distribution** yang berbeda (misalnya per sesi, per volatilitas regime), yang merupakan pertanyaan berbeda dari "rata-ratanya nol".

**Gerbang dekoratif.** Tujuh gerbang yang tidak pernah menolak satu sampel dalam setahun adalah pertanyaan terbuka tentang kode, bukan tentang pasar: apakah predikatnya terhubung ke jalur yang benar.

**Proksi harga.** Feed cadangan Binance (`bridge/feed.js`) hanya dipakai untuk sinyal **paper** waktu terminal mati, dan kualitas proksinya tidak merata: BTCUSD/ETHUSD masuk akal (keduanya memang kripto di kedua sisi), `EURUSDT` melenceng ±1,3% dari terminal dan bisa tampak membeku, `PAXGUSDT` ±7× lebih tenang daripada XAUUSD terminal. Karena ATR masuk langsung ke `minCost` dan pagar EA, proksi yang terlalu tenang akan **meloloskan** lebih banyak sinyal daripada broker asli. Angka apa pun yang lahir dari feed cadangan tidak boleh masuk analisis biaya.

**Yang tidak bisa diuji headless.** Break-even di `InBeAtR=0.6` pada geometri scanner, jalur rugi penuh di SL, cap +$25 / −$10 dengan angka nyata, loop ARM dari browser (order pernah dikirim dengan payload yang sama, tapi bukan dengan menekan tombol ARM dua-klik), transisi buka/tutup bursa dengan EA terpasang, dan pemulihan setelah **terminal** restart (yang terbukti baru reload EA di terminal yang tetap hidup, plus restart proses bridge).

---

## Lampiran A — angka rujukan cepat

| Hal | Nilai | Sumber |
|---|---|---|
| Horizon bar sinyal | `BAR_MIN = 15` menit | `engine.js:45` |
| Time-stop plan | `PLAN_TTL = 60` menit | `engine.js:52` |
| Break-even | `InBeAtR = 0.4` R (selaras `BE_AT_R` di `engine.js:51`) | `mt5/SniperBridge.mq5:50` |
| Pagar spread EA | `maks(30 pts, 25% × ATR)` = ATR/spread ≥ 4× | `scanner.js:36`, `SniperBridge.mq5:390` |
| Cooldown guard | 15 menit | `bridge/server.js` |
| Target / batas rugi harian | +$25 / −$10 | `bridge/server.js` |
| Watchdog status EA | 20 detik | `bridge/server.js` |
| Ekuitas minimum | floor guard (akun demo saja) | `guardDecide` |
| Risiko per trade | 1% × ekuitas (`riskPct`), plafon `maxOpenRiskUsd` default $20 | R5/R9 |
| `minCost` default bridge | 3,5 (bukan 4,0 seperti mode precision/auto) | `bridge/server.js:41` |
| `minSample` panel statistik | 20 trade | `bridge/server.js` |
| Data yang diukur | 45 hari (259 200 baris 15 dtk/aset) dan 365 hari (525 605 bar 1m, dua aset) | `tools/fetch_klines.js` |
| Regression suite | bridge 91 · scanner 70 · bridge_http 37 · ea_sim 11 langkah · ui_smoke 0 error | `tools/*` |

## Lampiran B — aturan pakar R1–R9 (ranking "pasangan mana yang boleh dibuka")

Setiap penolakan punya string alasan — bukan sekadar hilang dari daftar. Ini yang membuat audit biaya bisa dibaca.

| Aturan | Yang diperiksa |
|---|---|
| R1 data | bid/ask/ATR dari status EA masih segar |
| R2 sesi | pair sedang di dalam sesi trading-nya |
| R3 spread | spread points ≤ `maxSpreadPips` (default `PAIRS[pair].maxSpread`) |
| R4 biaya | ATR(pips) ≥ `minCost` × biaya(pips) — gerbang yang sama dengan engine |
| R5 saldo | lot minimum masih muat dengan risiko `riskPct` × ekuitas |
| R6 margin | margin pada volume yang diminta ≤ sebagian margin free |
| R7 riwayat | pair dibekukan kalau cukup sampel (`minSample`) dan hasil tercatat jelek |
| R8 tunggal | satu posisi per simbol; kalau sudah ada, tidak diantrikan lagi |
| R9 plafon | jumlah risiko terbuka + sisa ruang hari ini |

Catatan metodologi yang lahir dari R9: fixture yang menaikkan ekuitas 10× wajib menaikkan `maxOpenRiskUsd` 10× (`tools/scanner_test.js` pakai 250), karena `riskUsd = 1% × ekuitas` ikut naik dan yang diuji jadi "guard bekerja" selamanya, bukan scanner. Produksi tidak pernah kena: saldo $1 056 → risiko $10,56 vs plafon $20.

## Lampiran C — glosarium

**avgR** — rata-rata hasil per trade dalam satuan R (jarak SL = 1R). **PF** — profit factor. **MFE/MAE** — maximum/minimum favorable excursion, puncak profit/rugi dalam R. **`geoMiss`** — rugi padahal pernah ≥1R (salah keluar). **`dirMiss`** — rugi tanpa pernah melewati +0,5R (salah arah). **edge** — rata-rata return maju yang di-detrend per sinyal, dinyatakan dalam ATR. **drag spread** — biaya round-trip yang terpasang pada sinyal yang sama, dalam ATR. **stationary block bootstrap** — resampling blok geometris dengan panjang terdistribusi geometris, untuk menjaga korelasi serial di bawah distribusi nol. **detrend** — mengurangi pergerakan pasar yang terjadi dalam jendela yang sama supaya sinyal tidak dinilai oleh beta. **ablasi** — melepas satu gerbang, mengukur perubahan edge; Δ negatif berarti gerbang itu berguna. **walk-forward** — fold bergerak-maju, dinilai dari fold terburuk. **paper (scanner)** — sinyal dicatat tapi order tidak mungkin dikirim (sumber harga bukan terminal). **TRAIN/TEST** — 60%/40% di `tools/calibrate.js`, validasi dilakukan **satu kali**. **`dryRun`** — jalur order berjalan tapi tidak menulis order ke terminal. **`autoArm`** — scanner boleh mengirim order sendiri.

---

*Dokumen ini adalah turunan dari `README.md`; kalau keduanya bertentangan, `README.md` dan hasil `tools/*.js` yang menang. Perbarui Bagian 7 dan Lampiran A waktu ada jendela data baru.*
