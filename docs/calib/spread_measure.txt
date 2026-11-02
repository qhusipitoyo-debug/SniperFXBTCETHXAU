0) AKUN MT5 (sniper_status.txt tulisan EA) — ini satu-satunya angka yang akan benar-benar dibayar:
   folder /home/canary1/.var/app/com.usebottles.bottles/data/bottles/bottles/MT5/drive_c/Program Files/MetaTrader 5 EXNESS/MQL5/Files
   server FBS-Real • trade_mode=real • 181 baris status dalam 180 detik
   ⚠ trade_mode bukan demo — akun ini uang NYATA. dryRun/autoArm di bridge/config.json yang menahan, bukan tool ini.
   pair     median   p75    p90    p99    max    n  typSpread  akun/typ  verdict
   EURUSD     0.90  1.00  1.00  1.00  1.10   181  2.80p     0.32×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   USDJPY     0.90  0.90  1.00  1.00  1.10   181  4.00p     0.23×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   GBPUSD     1.10  1.10  1.10  1.20  1.20   181  4.50p     0.24×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   USDCHF     0.90  1.00  1.00  1.10  1.10   181  4.50p     0.20×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   AUDUSD     1.10  1.10  1.10  1.10  1.10   181  4.50p     0.24×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   USDCAD     1.10  1.10  1.10  1.20  1.20   181  4.50p     0.24×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   NZDUSD     1.20  1.20  1.20  1.20  1.20   181  4.00p     0.30×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   XAUUSD     2.50  2.80  3.10  3.70  3.70   181  4.50p     0.56×     typSpread TERLALU KETAT — mesin membayar biaya yang tidak ada (gerbang ATR/biaya lebih ketat dari seharusnya)
   BTCUSD    19.65 19.65 19.65 19.65 19.65   181 20.00p     0.98×     cukup dekat — asumsi layak dipertahankan
   ETHUSD    19.30 19.30 19.30 19.40 19.80   181 20.00p     0.97×     cukup dekat — asumsi layak dipertahankan

UKUR SPREAD • costPips() = max(spread feed, typSpread) + COST_EXTRA_PIPS(0)
Tool ini tidak mengubah apa pun di engine.js.

1) korpus data/*.csv — perhatikan kolom verdict: spread di file-file ini ditulis tool, bukan direkam pasar
pair     sumber                        n     median   p75    p90    p99    max   typ   verdict
EURUSD    Deriv (ditulis fetch_deriv)  141372  2.80  2.80  2.80  2.80  2.80  2.80  SINTETIS — hanya 1 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
USDJPY    Deriv (ditulis fetch_deriv)  141268  4.00  4.00  4.00  4.00  4.00  4.00  SINTETIS — hanya 1 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
GBPUSD    Deriv (ditulis fetch_deriv)  141268  4.40  4.50  4.50  4.50  4.50  4.50  SINTETIS — hanya 2 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
USDCHF    Deriv (ditulis fetch_deriv)  141272  4.60  4.60  4.60  4.60  4.60  4.50  SINTETIS — hanya 2 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
AUDUSD    Deriv (ditulis fetch_deriv)  141276  4.60  4.60  4.60  4.60  4.60  4.50  SINTETIS — hanya 2 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
USDCAD    Deriv (ditulis fetch_deriv)  141276  4.40  4.50  4.50  4.50  4.50  4.50  SINTETIS — hanya 2 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
NZDUSD    Deriv (ditulis fetch_deriv)  141280  4.00  4.00  4.00  4.00  4.00  4.00  SINTETIS — hanya 1 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
XAUUSD    Binance PAXG                2102412  4.60  4.60  4.60  4.60  4.60  4.50  SINTETIS — hanya 3 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
BTCUSD    Binance BTCUSDT             2102420 20.00 20.00 20.00 20.00 20.00 20.00  SINTETIS — hanya 1 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
ETHUSD    Binance ETHUSDT              259204 15.00 15.00 15.00 15.00 15.00 20.00  SINTETIS — hanya 1 nilai spread berbeda; ini typSpread yang ditulis fetch_deriv/fetch_klines, BUKAN pengukuran
3) apa yang berubah di gerbang ATR/biaya kalau biaya diambil dari spread yang benar-benar terukur:
pair     biaya sekarang  biaya terukur  minCost  butuh ATR sekarang  butuh ATR terukur  sumber
EURUSD     2.80p            0.90p       4.0×   11.20p            3.60p         AKUN MT5
USDJPY     4.00p            0.90p       3.5×   14.00p            3.15p         AKUN MT5
GBPUSD     4.50p            1.10p       3.5×   15.75p            3.85p         AKUN MT5
USDCHF     4.60p            0.90p       3.5×   16.10p            3.15p         AKUN MT5
AUDUSD     4.60p            1.10p       3.5×   16.10p            3.85p         AKUN MT5
USDCAD     4.50p            1.10p       3.5×   15.75p            3.85p         AKUN MT5
NZDUSD     4.00p            1.20p       3.5×   14.00p            4.20p         AKUN MT5
XAUUSD     4.60p            2.50p       3.8×   17.48p            9.50p         AKUN MT5
BTCUSD    20.00p           19.65p       3.5×   70.00p           68.77p         AKUN MT5
ETHUSD    20.00p           19.30p       4.0×   80.00p           77.20p         AKUN MT5

CATATAN: angka "terukur" di atas adalah median selama 180 detik dari akun FBS-Real. Spread ritel melebar di rollover/berita; satu jendela pendek bukan distribusi. Kalau yang terukur JAUH di bawah typSpread,
         gerbang ATR/biaya kita lebih ketat dari biaya sebenarnya — itu menahan entry yang sebenarnya layak, dan itu
         keputusan untuk dipasang atau tidak, bukan kesimpulan yang bisa ditarik tool ini sendiri.
