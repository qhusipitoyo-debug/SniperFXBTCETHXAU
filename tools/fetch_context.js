#!/usr/bin/env node
'use strict';
/* Ambil kalender ekonomi (ForexFactory/FairEconomy) & sentimen pasar (Fear & Greed + Binance 24h)
   lalu tulis ke stats/calendar.json & stats/sentiment.json agar frontend GitHub Pages bebas CORS
   dan tools/collector.js memakai konteks berita + sentimen yang identik. */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const STATS_DIR = path.join(ROOT, 'stats');
const CAL_PATH = path.join(STATS_DIR, 'calendar.json');
const SENT_PATH = path.join(STATS_DIR, 'sentiment.json');

const FF_URLS = [
  'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
  'https://nfs.faireconomy.media/ff_calendar_nextweek.json'
];
const FNG_URL = 'https://api.alternative.me/fng/?limit=7';
const BINANCE_24H_URL = 'https://data-api.binance.vision/api/v3/ticker/24hr?symbols=' +
  encodeURIComponent(JSON.stringify(['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'PAXGUSDT', 'EURUSDT']));

async function getJson(url, timeoutMs = 8000) {
  const ac = new AbortController();
  const tm = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { 'user-agent': 'SniperFX-Context/1.0' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return await res.json();
  } finally {
    clearTimeout(tm);
  }
}

function normImpact(raw) {
  const s = String(raw || '').toLowerCase();
  if (s === '3' || s.includes('high') || s.includes('merah')) return 'High';
  if (s === '2' || s.includes('med')) return 'Medium';
  if (s === '1' || s.includes('low')) return 'Low';
  return 'Holiday';
}

function parseCalendarItems(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const e of list) {
    if (!e) continue;
    const rawTs = e.ts != null ? Number(e.ts) : Date.parse(e.date || e.time || e.datetime || '');
    const ts = Number.isFinite(rawTs) ? (rawTs < 1e12 ? rawTs * 1000 : rawTs) : NaN;
    const country = String(e.country || e.currency || e.ccy || '').toUpperCase().trim();
    const title = String(e.title || e.event || e.name || '').trim();
    if (!Number.isFinite(ts) || !country || !title) continue;
    out.push({
      ts,
      date: new Date(ts).toISOString(),
      country,
      title,
      impact: normImpact(e.impact),
      forecast: e.forecast != null ? String(e.forecast).trim() : '',
      previous: e.previous != null ? String(e.previous).trim() : '',
      actual: e.actual != null ? String(e.actual).trim() : ''
    });
  }
  return out;
}

function writeAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

async function fetchCalendar(now) {
  const existing = [];
  try {
    if (fs.existsSync(CAL_PATH)) {
      const old = JSON.parse(fs.readFileSync(CAL_PATH, 'utf8'));
      const arr = Array.isArray(old) ? old : (Array.isArray(old && old.events) ? old.events : []);
      for (const e of parseCalendarItems(arr)) {
        if (Math.abs(e.ts - now) <= 7 * 86400000) existing.push(e);
      }
    }
  } catch {}

  const fetched = [];
  for (const url of FF_URLS) {
    try {
      const d = await getJson(url);
      fetched.push(...parseCalendarItems(d));
    } catch {}
  }
  if (!fetched.length && existing.length) {
    return { updatedAt: new Date(now).toISOString(), source: 'cache', count: existing.length, events: existing };
  }

  const byKey = new Map();
  for (const e of existing.concat(fetched)) {
    const key = e.country + '|' + e.title + '|' + Math.round(e.ts / 60000);
    const prev = byKey.get(key);
    if (!prev || (!prev.actual && e.actual) || (!prev.forecast && e.forecast)) {
      byKey.set(key, e);
    }
  }
  const events = [...byKey.values()].sort((a, b) => a.ts - b.ts);
  return {
    updatedAt: new Date(now).toISOString(),
    source: fetched.length ? 'faireconomy' : 'empty',
    count: events.length,
    events
  };
}

async function fetchSentiment(now) {
  let prevSent = null;
  try {
    if (fs.existsSync(SENT_PATH)) prevSent = JSON.parse(fs.readFileSync(SENT_PATH, 'utf8'));
  } catch {}

  let fng = prevSent && prevSent.fng ? prevSent.fng : null;
  try {
    const d = await getJson(FNG_URL);
    const arr = Array.isArray(d && d.data) ? d.data : [];
    if (arr.length) {
      const val = Number(arr[0].value);
      const prev = arr.length > 1 ? Number(arr[1].value) : val;
      const w7 = arr.length > 6 ? Number(arr[6].value) : Number(arr[arr.length - 1].value);
      fng = {
        value: val,
        classification: String(arr[0].value_classification || 'Neutral'),
        delta1d: Number((val - prev).toFixed(1)),
        delta7d: Number((val - w7).toFixed(1)),
        score: Number(((val - 50) / 50).toFixed(3)) // -1 extreme fear .. +1 extreme greed
      };
    }
  } catch {}

  let market24h = prevSent && prevSent.market24h ? prevSent.market24h : null;
  try {
    const arr = await getJson(BINANCE_24H_URL);
    if (Array.isArray(arr) && arr.length) {
      const map = {};
      for (const x of arr) {
        map[x.symbol] = {
          pct24h: Number(Number(x.priceChangePercent).toFixed(3)),
          last: Number(x.lastPrice),
          quoteVolM: Number((Number(x.quoteVolume) / 1e6).toFixed(1))
        };
      }
      const cryptoList = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT'].filter(s => map[s]);
      const cryptoAvgPct = cryptoList.length
        ? Number((cryptoList.reduce((a, s) => a + map[s].pct24h, 0) / cryptoList.length).toFixed(3))
        : 0;
      const eurPct = map.EURUSDT ? map.EURUSDT.pct24h : 0;
      const goldPct = map.PAXGUSDT ? map.PAXGUSDT.pct24h : 0;
      market24h = {
        cryptoAvgPct,
        eurPct,
        goldPct,
        riskBias: Number(Math.max(-1, Math.min(1, cryptoAvgPct / 4)).toFixed(3)),
        usdProxyBias: Number(Math.max(-1, Math.min(1, -eurPct / 1.0)).toFixed(3)), // >0 = USD menguat
        symbols: map
      };
    }
  } catch {}

  // Ringkasan rezim makro gabungan (-1 risk-off .. +1 risk-on)
  const fngScore = fng ? fng.score : 0;
  const risk24 = market24h ? market24h.riskBias : 0;
  const riskScore = Number((0.45 * fngScore + 0.55 * risk24).toFixed(3));
  const regime = riskScore >= 0.2 ? 'RISK_ON' : riskScore <= -0.2 ? 'RISK_OFF' : 'NEUTRAL';

  return {
    updatedAt: new Date(now).toISOString(),
    fng,
    market24h,
    regime,
    riskScore
  };
}

(async () => {
  const now = Date.now();
  const [cal, sent] = await Promise.all([fetchCalendar(now), fetchSentiment(now)]);
  writeAtomic(CAL_PATH, cal);
  writeAtomic(SENT_PATH, sent);
  console.log(`context ok • calendar=${cal.count} (${cal.source}) • fng=${sent.fng ? sent.fng.value + ' ' + sent.fng.classification : 'n/a'} • regime=${sent.regime} (${sent.riskScore})`);
})().catch(e => {
  console.error('fetch_context err:', e.message);
  process.exit(1);
});
