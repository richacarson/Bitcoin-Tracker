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

async function krakenPrivate(creds, endpoint, params = {}) {
  const { key, secret } = creds;
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
export async function fetchKrakenTrades(creds, sinceSec = 0) {
  const trades = [];
  let ofs = 0;
  for (;;) {
    const params = { ofs: String(ofs) };
    if (sinceSec) params.start = String(sinceSec);
    const result = await krakenPrivate(creds, 'TradesHistory', params);
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

const isBtcAsset = (a) => a === 'XXBT' || a === 'XBT' || a.startsWith('XBT.') || a.startsWith('XXBT.');
const isUsdAsset = (a) => ['ZUSD', 'USD', 'USDT', 'USDC'].includes(a) || a.startsWith('ZUSD.') || a.startsWith('USD.');

// Full account ledger, turned into buys/sells and transfers.
//
// Kraken's Instant Buy / recurring-purchase feature does NOT appear in
// TradesHistory — each purchase is a pair of ledger entries sharing a
// refid: a fiat `spend` and a BTC `receive` (a sale is the mirror image).
// Orderbook trades appear in the ledger as type `trade` and are skipped
// here because TradesHistory already covers them.
export async function fetchKrakenLedger(creds, sinceSec = 0) {
  const rows = [];
  let ofs = 0;
  for (;;) {
    const params = { ofs: String(ofs) };
    if (sinceSec) params.start = String(sinceSec);
    const result = await krakenPrivate(creds, 'Ledgers', params);
    const entries = Object.entries(result.ledger || {});
    for (const [lid, l] of entries) rows.push({ lid, ...l });
    ofs += entries.length;
    if (entries.length === 0 || ofs >= (result.count || 0)) break;
    await sleep(PAGE_DELAY_MS);
  }

  const trades = [];
  const transfers = [];
  const byRefid = new Map();
  for (const row of rows) {
    if (row.type === 'withdrawal' || row.type === 'deposit') {
      if (!isBtcAsset(row.asset)) continue; // fiat funding in/out is not a BTC transfer
      transfers.push({
        id: `kraken:${row.lid}`,
        source: 'kraken',
        date: new Date(row.time * 1000).toISOString(),
        type: row.type === 'withdrawal' ? 'send' : 'receive',
        btc: Math.abs(parseFloat(row.amount)),
        networkFeeBtc: parseFloat(row.fee) || 0,
      });
    } else if (row.type === 'spend' || row.type === 'receive') {
      if (!byRefid.has(row.refid)) byRefid.set(row.refid, []);
      byRefid.get(row.refid).push(row);
    }
  }

  for (const group of byRefid.values()) {
    const btcRow = group.find((r) => isBtcAsset(r.asset));
    const usdRow = group.find((r) => isUsdAsset(r.asset));
    if (!btcRow || !usdRow) continue; // e.g. a non-BTC instant buy
    const date = new Date(btcRow.time * 1000).toISOString();
    if (btcRow.type === 'receive' && usdRow.type === 'spend') {
      // Instant/recurring buy: cash out (incl. fee), BTC in (net of fee).
      const usd = Math.abs(parseFloat(usdRow.amount)) + (parseFloat(usdRow.fee) || 0);
      const btc = parseFloat(btcRow.amount) - (parseFloat(btcRow.fee) || 0);
      if (btc <= 0 || usd <= 0) continue;
      trades.push({
        id: `kraken:${btcRow.lid}`, source: 'kraken', date,
        type: 'buy', btc, usd, fee: parseFloat(usdRow.fee) || 0, price: usd / btc,
      });
    } else if (btcRow.type === 'spend' && usdRow.type === 'receive') {
      const btc = Math.abs(parseFloat(btcRow.amount)) + (parseFloat(btcRow.fee) || 0);
      const usd = parseFloat(usdRow.amount) - (parseFloat(usdRow.fee) || 0);
      if (btc <= 0 || usd <= 0) continue;
      trades.push({
        id: `kraken:${btcRow.lid}`, source: 'kraken', date,
        type: 'sell', btc, usd, fee: parseFloat(usdRow.fee) || 0, price: usd / btc,
      });
    }
  }

  return { trades, transfers };
}

export async function fetchKrakenBalance(creds) {
  const result = await krakenPrivate(creds, 'Balance');
  let btc = 0;
  for (const [asset, amount] of Object.entries(result)) {
    if (asset === 'XXBT' || asset === 'XBT' || asset.startsWith('XBT.')) btc += parseFloat(amount);
  }
  return btc;
}

export const krakenConfigured = (creds) => Boolean(creds?.key && creds?.secret);
