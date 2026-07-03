import crypto from 'crypto';
import { sleep } from './util.js';

const API_HOST = 'https://api.kraken.com';
// Kraken's private-endpoint rate limiter allows a small burst then ~0.5
// calls/sec sustained; history endpoints cost double, so pace generously.
const PAGE_DELAY_MS = 3000;

function signRequest(urlPath, postData, nonce, secret) {
  const secretBuf = Buffer.from(secret, 'base64');
  const hash = crypto.createHash('sha256').update(nonce + postData).digest();
  return crypto
    .createHmac('sha512', secretBuf)
    .update(Buffer.concat([Buffer.from(urlPath, 'utf8'), hash]))
    .digest('base64');
}

async function krakenPrivate(endpoint, params = {}) {
  const key = process.env.KRAKEN_API_KEY;
  const secret = process.env.KRAKEN_API_SECRET;
  const urlPath = `/0/private/${endpoint}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const nonce = (BigInt(Date.now()) * 1000n + BigInt(attempt)).toString();
    const postData = new URLSearchParams({ nonce, ...params }).toString();
    const res = await fetch(API_HOST + urlPath, {
      method: 'POST',
      headers: {
        'API-Key': key,
        'API-Sign': signRequest(urlPath, postData, nonce, secret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    });
    const body = await res.json();
    const errors = body.error || [];
    if (errors.some((e) => e.includes('Rate limit'))) {
      await sleep(5000 * (attempt + 1));
      continue;
    }
    if (errors.length) throw new Error(`Kraken ${endpoint}: ${errors.join(', ')}`);
    return body.result;
  }
  throw new Error(`Kraken ${endpoint}: rate limited after retries`);
}

const USD_QUOTES = ['ZUSD', 'USD', 'USDT', 'USDC'];

function isBtcUsdPair(pair) {
  const base = pair.startsWith('XXBT') ? 'XXBT' : pair.startsWith('XBT') ? 'XBT' : null;
  if (!base) return false;
  return USD_QUOTES.includes(pair.slice(base.length));
}

// All BTC/USD trades, normalized. usd = total cost including fee for buys,
// net proceeds after fee for sells.
export async function fetchKrakenTrades(sinceSec = 0) {
  const trades = [];
  let ofs = 0;
  for (;;) {
    const params = { ofs: String(ofs) };
    if (sinceSec) params.start = String(sinceSec);
    const result = await krakenPrivate('TradesHistory', params);
    const entries = Object.entries(result.trades || {});
    for (const [txid, t] of entries) {
      if (!isBtcUsdPair(t.pair)) continue;
      const btc = parseFloat(t.vol);
      const cost = parseFloat(t.cost);
      const fee = parseFloat(t.fee);
      trades.push({
        id: `kraken:${txid}`,
        source: 'kraken',
        date: new Date(t.time * 1000).toISOString(),
        type: t.type, // 'buy' | 'sell'
        btc,
        usd: t.type === 'buy' ? cost + fee : cost - fee,
        fee,
        price: parseFloat(t.price),
      });
    }
    ofs += entries.length;
    if (entries.length === 0 || ofs >= (result.count || 0)) break;
    await sleep(PAGE_DELAY_MS);
  }
  return trades;
}

// BTC deposits/withdrawals from the ledger — used to track coins moved to
// Phantom (transfers are not disposals; they never touch cost basis).
export async function fetchKrakenTransfers(sinceSec = 0) {
  const transfers = [];
  let ofs = 0;
  for (;;) {
    const params = { asset: 'XBT', ofs: String(ofs) };
    if (sinceSec) params.start = String(sinceSec);
    const result = await krakenPrivate('Ledgers', params);
    const entries = Object.entries(result.ledger || {});
    for (const [lid, l] of entries) {
      if (l.type !== 'withdrawal' && l.type !== 'deposit') continue;
      const amount = parseFloat(l.amount);
      transfers.push({
        id: `kraken:${lid}`,
        source: 'kraken',
        date: new Date(l.time * 1000).toISOString(),
        type: l.type === 'withdrawal' ? 'send' : 'receive',
        btc: Math.abs(amount),
        networkFeeBtc: parseFloat(l.fee) || 0,
      });
    }
    ofs += entries.length;
    if (entries.length === 0 || ofs >= (result.count || 0)) break;
    await sleep(PAGE_DELAY_MS);
  }
  return transfers;
}

export async function fetchKrakenBalance() {
  const result = await krakenPrivate('Balance');
  let btc = 0;
  for (const [asset, amount] of Object.entries(result)) {
    if (asset === 'XXBT' || asset === 'XBT' || asset.startsWith('XBT.')) btc += parseFloat(amount);
  }
  return btc;
}

export const krakenConfigured = () =>
  Boolean(process.env.KRAKEN_API_KEY && process.env.KRAKEN_API_SECRET);
