import { dayKey } from './util.js';

// Deterministic demo portfolio so the dashboard is fully explorable before
// any API keys are configured. Uses real historical prices when available.
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildSampleData(dailyPrices, currentPrice) {
  const rand = mulberry32(42);
  const priceOn = (ms) => dailyPrices[dayKey(ms)] || currentPrice;
  const DAY = 86400000;
  const now = Date.now();
  const trades = [];
  const transfers = [];
  let id = 0;

  const buy = (ms, usd, source) => {
    const price = priceOn(ms) * (1 + (rand() - 0.5) * 0.01);
    const fee = usd * (source === 'coinbase' ? 0.0149 : 0.004);
    trades.push({
      id: `sample:${id++}`,
      source,
      date: new Date(ms).toISOString(),
      type: 'buy',
      btc: (usd - fee) / price,
      usd,
      fee,
      price,
    });
  };

  // Early Coinbase lump purchases (~3 years ago)
  for (let i = 0; i < 6; i++) {
    buy(now - (1100 - i * 45) * DAY, 400 + Math.round(rand() * 1200), 'coinbase');
  }
  // Two later lump sums on Kraken
  buy(now - 500 * DAY, 5000, 'kraken');
  buy(now - 260 * DAY, 2500, 'kraken');
  // Daily $25 DCA on Kraken for the last ~14 months
  for (let d = 420; d >= 0; d--) buy(now - d * DAY, 25, 'kraken');

  // Periodic sweeps to Phantom
  let phantom = 0;
  for (const daysAgo of [700, 400, 180, 60]) {
    const ms = now - daysAgo * DAY;
    const btc = 0.05 + rand() * 0.04;
    phantom += btc;
    transfers.push({
      id: `sample:${id++}`,
      source: 'kraken',
      date: new Date(ms).toISOString(),
      type: 'send',
      btc,
      networkFeeBtc: 0.00002,
    });
  }

  const totalBtc = trades.reduce((s, t) => s + (t.type === 'buy' ? t.btc : -t.btc), 0);
  const feesBtc = transfers.length * 0.00002;
  return {
    trades,
    transfers,
    balances: {
      kraken: totalBtc - phantom - feesBtc - 0.011,
      coinbase: 0.011,
      onchain: phantom,
    },
  };
}
