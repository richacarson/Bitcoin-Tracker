import path from 'path';
import { fetchJson, readJsonFile, writeJsonFile, sleep, dayKey } from './util.js';

const CACHE_FILE = path.join(process.cwd(), 'data', 'prices.json');
const DAY_MS = 86400 * 1000;

export async function fetchCurrentPrice() {
  const body = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
  const ticker = Object.values(body.result || {})[0];
  return parseFloat(ticker.c[0]);
}

async function fetchCandlesCoinbase(startMs, endMs) {
  // Public Coinbase Exchange API: daily candles, max 300 per request.
  const days = {};
  for (let from = startMs; from < endMs; from += 300 * DAY_MS) {
    const to = Math.min(from + 300 * DAY_MS, endMs);
    const url =
      `https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=86400` +
      `&start=${new Date(from).toISOString()}&end=${new Date(to).toISOString()}`;
    const candles = await fetchJson(url, { headers: { 'User-Agent': 'bitcoin-tracker' } });
    for (const [time, , , , close] of candles) days[dayKey(time * 1000)] = close;
    await sleep(350);
  }
  return days;
}

async function fetchCandlesKraken() {
  // Fallback: ~720 most recent daily candles, single call.
  const body = await fetchJson('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
  const rows = Object.values(body.result).find(Array.isArray) || [];
  const days = {};
  for (const [time, , , , close] of rows) days[dayKey(time * 1000)] = parseFloat(close);
  return days;
}

// Trailing CAGR (%) over `years`, from the cached daily closes: compares the
// current price to the close nearest to `years` ago (within ±14 days).
// Recomputed on every dashboard load, so it drifts with the market daily.
export function trailingCagrPct(days, currentPrice, years = 4) {
  if (!currentPrice) return null;
  const target = Date.now() - years * 365.25 * DAY_MS;
  for (let off = 0; off <= 14; off++) {
    for (const sign of off ? [-1, 1] : [1]) {
      const past = days[dayKey(target + sign * off * DAY_MS)];
      if (past > 0) return (Math.pow(currentPrice / past, 1 / years) - 1) * 100;
    }
  }
  return null;
}

// Daily close history from `sinceMs` to now, cached on disk and topped up
// incrementally on each call.
export async function getDailyPrices(sinceMs) {
  const cache = readJsonFile(CACHE_FILE, { days: {} });
  const days = cache.days || {};
  const have = Object.keys(days).sort();
  const wantStart = dayKey(sinceMs);
  const today = dayKey(Date.now());

  const needBackfill = !have.length || have[0] > wantStart;
  const needTopUp = !have.length || have[have.length - 1] < today;

  if (needBackfill || needTopUp) {
    try {
      const from = needBackfill ? sinceMs : new Date(have[have.length - 1]).getTime();
      Object.assign(days, await fetchCandlesCoinbase(from, Date.now() + DAY_MS));
    } catch {
      Object.assign(days, await fetchCandlesKraken());
    }
    writeJsonFile(CACHE_FILE, { updated: new Date().toISOString(), days });
  }
  return days;
}
