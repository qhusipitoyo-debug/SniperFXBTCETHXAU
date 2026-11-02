# Arsip keluaran mentah kalibrasi

Isinya dump teks apa adanya dari `tools/*` yang dibahas di log README, supaya klaim di halaman itu
bisa dibaca ulang tanpa menjalankan ulang harness (yang mahal: 365 hari × 2 juta tick per pass).
**Bukan hasil yang bisa dipakai apa adanya** — tiap file punya asumsi dan lubang yang dicatat di
README; kolom yang tidak terisi berarti alatnya tidak mengukur hal itu.

| file | alat | apa yang diuji |
|---|---|---|
| `spread_measure.txt` | `_spread_measure.js --akun=180` | spread AKUN MT5 terukur (181 baris `sniper_status.txt`) vs `typSpread` engine, dan bukti bahwa kolom spread di `data/*.csv` sintetis |
| `ait_geom.txt`, `ait_geom_xau.txt` | `_ait_geom.js` | geometri TP/SL repo `aiterminaltrading` direplay di entry engine kita (Δ ± SE berpasangan, TEST) |
| `ait_dir.txt`, `ait_dir_fx.txt`, `ait_dir_xau150.txt` | `_ait_dir.js` | aturan arah grid-breakout mereka vs arah mentah engine, dengan bootstrap dan drag spread |
| `hour_oos.txt`, `hour_oos_s50.txt` | `_hour_oos.js` | allowlist jam `PAIRS[].hours` dipilih di TRAIN, dinilai di TEST (dua split) — dasar keputusan "hours jadi label" |
| `floor_oos_xau.txt`, `floor_oos_eth_eur.txt` | `_floor_oos.js` | `calib.modeFloor` diuji keluar-sampel |
| `fx_funnel.txt`, `fx_funnel_eur.txt` | `_fx_funnel.js` | berapa banyak evaluasi per gerbang yang benar-benar tersisa untuk tujuh major FX |
| `fx_mincost.txt` | `_fx_mincost_sweep.js` | sapuan lantai `minCost` |
| `fx_signal.txt` | `signal_test.js` | sinyal vs hasil (ablation per gerbang) |
| `fx_hour_calib.txt` | `_fx_hour_calib.js` | pemilihan jam IN-SAMPLE — artefak yang dikoreksi oleh `hour_oos*` |

Peringatan yang berlaku untuk semua file: angka "terukur" di kolom spread tidak pernah mengukur biaya
akun sebelum 2-11-2026 (`fetch_deriv.js` menulis `bid/ask = mid ± typSpread·pip/2`), dan hasil
train/test di sini dinilai pada korpus 35–365 hari yang sama — jangan dipakai untuk memilih ambang
tanpa uji keluar-sampel yang disebut di baris terkait.
