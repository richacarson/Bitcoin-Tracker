// Bitcoin Tracker — Supabase Edge Function build.
// Same app as server.js, ported to Deno: state lives in the
// btc_tracker_state table (service-role only) instead of data/*.json,
// and Node crypto is replaced with @noble primitives.
import { sha256 } from 'npm:@noble/hashes@1.4.0/sha256';
import { sha512 } from 'npm:@noble/hashes@1.4.0/sha512';
import { hmac } from 'npm:@noble/hashes@1.4.0/hmac';
import { scrypt } from 'npm:@noble/hashes@1.4.0/scrypt';
import { p256 } from 'npm:@noble/curves@1.4.0/p256';
import { ed25519 } from 'npm:@noble/curves@1.4.0/ed25519';
import { computePortfolio } from './costbasis.js';
import { buildSampleData } from './sample.js';
import { normalizeManual } from './manual.js';
import { dayKey } from './dates.js';
import * as webauthn from './webauthn.js';
import { ASSETS } from './assets.ts';

const FN_NAME = 'btc-tracker';
const EXT_BASE = `/functions/v1/${FN_NAME}/`;
const COOKIE = 'btctracker_session';
const SESSION_DAYS = 30;
const DAY_MS = 86400000;

// ── Small helpers ────────────────────────────────────────────────────────
const te = new TextEncoder();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const bytesToB64 = (b: Uint8Array) => btoa(Array.from(b, (c) => String.fromCharCode(c)).join(''));
const b64ToBytes = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const bytesToB64url = (b: Uint8Array) => bytesToB64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const strToB64url = (s: string) => bytesToB64url(te.encode(s));
const b64urlToStr = (s: string) => atob(s.replace(/-/g, '+').replace(/_/g, '/'));
const bytesToHex = (b: Uint8Array) => Array.from(b, (c) => c.toString(16).padStart(2, '0')).join('');
const hexToBytes = (s: string) => new Uint8Array((s.match(/.{2}/g) || []).map((h) => parseInt(h, 16)));
const concatBytes = (...arrs: Uint8Array[]) => {
  const out = new Uint8Array(arrs.reduce((s, a) => s + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};
function timingEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}
async function fetchJson(url: string, options: any = {}, retries = 2) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      if (!res.ok) {
        const err: any = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 200)}`);
        if (res.status !== 429 && res.status < 500) { err.fatal = true; }
        throw err;
      }
      return JSON.parse(text);
    } catch (err: any) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await sleep(1500 * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

// ── State store (btc_tracker_state, service-role only) ──────────────────
const SB_URL = Deno.env.get('SUPABASE_URL')!;
const SB_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const kvHeaders = {
  apikey: SB_KEY,
  authorization: `Bearer ${SB_KEY}`,
  'content-type': 'application/json',
};
async function kvGet(key: string) {
  const res = await fetch(`${SB_URL}/rest/v1/btc_tracker_state?key=eq.${key}&select=value`, { headers: kvHeaders });
  if (!res.ok) throw new Error(`state read failed (${res.status})`);
  const rows = await res.json();
  return rows[0]?.value ?? null;
}
async function kvSet(key: string, value: unknown) {
  const res = await fetch(`${SB_URL}/rest/v1/btc_tracker_state`, {
    method: 'POST',
    headers: { ...kvHeaders, prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`state write failed (${res.status}): ${await res.text()}`);
}

// ── Auth ─────────────────────────────────────────────────────────────────
const USERNAME = Deno.env.get('AUTH_USERNAME') || 'richacarson';
async function getAuthRecord() {
  return (await kvGet('auth')) || {};
}
async function ensureSessionSecret() {
  const rec = await getAuthRecord();
  if (!rec.sessionSecret) {
    rec.sessionSecret = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    await kvSet('auth', rec);
  }
  return rec.sessionSecret;
}
const scryptHash = (password: string, saltHex: string) =>
  bytesToHex(scrypt(te.encode(password), hexToBytes(saltHex), { N: 16384, r: 8, p: 1, dkLen: 64 }));

async function setPassword(password: unknown) {
  const rec = await getAuthRecord();
  if (rec.hash) throw new Error('Password is already set');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  rec.username = USERNAME;
  rec.salt = bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
  rec.hash = scryptHash(password, rec.salt);
  await kvSet('auth', rec);
}
async function verifyPassword(user: string, password: string) {
  const rec = await getAuthRecord();
  const pad = (s: string) => te.encode(String(s).toLowerCase().padEnd(64).slice(0, 64));
  const userOk = timingEqual(pad(user), pad(USERNAME));
  let passOk = false;
  if (rec.hash && rec.salt) {
    passOk = timingEqual(hexToBytes(scryptHash(String(password), rec.salt)), hexToBytes(rec.hash));
  }
  return userOk && passOk;
}
function signPayload(payload: string, secret: string) {
  return bytesToB64url(hmac(sha256, te.encode(secret), te.encode(payload)));
}
async function issueToken() {
  const secret = await ensureSessionSecret();
  const payload = `${USERNAME}.${Date.now() + SESSION_DAYS * DAY_MS}`;
  return `${strToB64url(payload)}.${signPayload(payload, secret)}`;
}
async function verifyToken(token: string | null) {
  if (!token) return false;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return false;
  let payload;
  try { payload = b64urlToStr(body); } catch { return false; }
  const expected = signPayload(payload, await ensureSessionSecret());
  if (!timingEqual(te.encode(sig), te.encode(expected))) return false;
  const expires = parseInt(payload.split('.').pop() || '', 10);
  return Number.isFinite(expires) && Date.now() < expires;
}
function tokenFromRequest(req: Request) {
  const bearer = (req.headers.get('authorization') || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1];
  const cookies = req.headers.get('cookie') || '';
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return match ? match.slice(COOKIE.length + 1) : null;
}
const cookieHeader = (token: string, maxAgeSec: number) =>
  `${COOKIE}=${token}; Path=${EXT_BASE}; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAgeSec}`;

// Per-isolate brute-force throttle (best effort on serverless).
const attempts = new Map<string, { fails: number; lockedUntil: number }>();
function loginAllowed(ip: string) {
  const a = attempts.get(ip);
  return !a || Date.now() > (a.lockedUntil || 0);
}
function recordLogin(ip: string, ok: boolean) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= 8) { a.lockedUntil = Date.now() + 15 * 60000; a.fails = 0; }
  attempts.set(ip, a);
}

// ── Settings (exchange keys, phantom addresses, manual entries) ─────────
const SECRET_FIELDS = ['krakenKey', 'krakenSecret', 'coinbaseKeyName', 'coinbasePrivateKey'];
const FIELDS = [...SECRET_FIELDS, 'phantomAddresses', 'manual', 'startDate'];
async function getConfig() {
  const s = (await kvGet('settings')) || {};
  const addresses = Deno.env.get('PHANTOM_BTC_ADDRESSES') || s.phantomAddresses || '';
  return {
    kraken: {
      key: Deno.env.get('KRAKEN_API_KEY') || s.krakenKey || '',
      secret: Deno.env.get('KRAKEN_API_SECRET') || s.krakenSecret || '',
    },
    coinbase: {
      keyName: Deno.env.get('COINBASE_API_KEY_NAME') || s.coinbaseKeyName || '',
      privateKey: Deno.env.get('COINBASE_API_PRIVATE_KEY') || s.coinbasePrivateKey || '',
    },
    phantomAddresses: addresses.split(',').map((a: string) => a.trim()).filter(Boolean),
    manual: Array.isArray(s.manual) ? s.manual : [],
    startDate: s.startDate || '',
  };
}
async function saveSettings(patch: any) {
  const settings = (await kvGet('settings')) || {};
  for (const field of FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v === '' || v == null) delete settings[field];
    else settings[field] = v;
  }
  if (settings.manual && !Array.isArray(settings.manual)) {
    throw new Error('manual must be a JSON array of {date, type, btc, usd} entries');
  }
  await kvSet('settings', settings);
}
async function publicSettings() {
  const cfg = await getConfig();
  return {
    kraken: Boolean(cfg.kraken.key && cfg.kraken.secret),
    coinbase: Boolean(cfg.coinbase.keyName && cfg.coinbase.privateKey),
    phantomAddresses: cfg.phantomAddresses.join(', '),
    manualCount: cfg.manual.length,
    startDate: cfg.startDate,
  };
}

// ── Kraken client ────────────────────────────────────────────────────────
const KRAKEN_HOST = 'https://api.kraken.com';
// Starter-tier accounts decay 0.33 points/sec and history calls cost 2
// points, so anything faster than one call per ~6s saturates the counter.
const PAGE_DELAY_MS = 6500;
function krakenSign(urlPath: string, postData: string, nonce: string, secretB64: string) {
  const digest = sha256(te.encode(nonce + postData));
  return bytesToB64(hmac(sha512, b64ToBytes(secretB64), concatBytes(te.encode(urlPath), digest)));
}
async function krakenPrivate(creds: any, endpoint: string, params: Record<string, string> = {}) {
  const urlPath = `/0/private/${endpoint}`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const nonce = String(Date.now() * 1000 + attempt);
    const postData = new URLSearchParams({ nonce, ...params }).toString();
    const res = await fetch(KRAKEN_HOST + urlPath, {
      method: 'POST',
      headers: {
        'API-Key': creds.key,
        'API-Sign': krakenSign(urlPath, postData, nonce, creds.secret),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: postData,
    });
    const body = await res.json();
    const errors = body.error || [];
    if (errors.some((e: string) => e.includes('Rate limit'))) { await sleep(15000 * (attempt + 1)); continue; }
    if (errors.length) throw new Error(`Kraken ${endpoint}: ${errors.join(', ')}`);
    return body.result;
  }
  const err: any = new Error(`Kraken ${endpoint}: rate limited after retries`);
  err.rateLimited = true;
  throw err;
}
const USD_QUOTES = ['ZUSD', 'USD', 'USDT', 'USDC'];
function isBtcUsdPair(pair: string) {
  const base = pair.startsWith('XXBT') ? 'XXBT' : pair.startsWith('XBT') ? 'XBT' : null;
  return base ? USD_QUOTES.includes(pair.slice(base.length)) : false;
}
async function fetchKrakenTrades(creds: any, sinceSec = 0) {
  const trades: any[] = [];
  let ofs = 0;
  for (;;) {
    const params: Record<string, string> = { ofs: String(ofs) };
    if (sinceSec) params.start = String(sinceSec);
    const result = await krakenPrivate(creds, 'TradesHistory', params);
    const entries = Object.entries(result.trades || {});
    for (const [txid, t] of entries as [string, any][]) {
      if (!isBtcUsdPair(t.pair)) continue;
      const btc = parseFloat(t.vol), cost = parseFloat(t.cost), fee = parseFloat(t.fee);
      trades.push({
        id: `kraken:${txid}`, source: 'kraken',
        date: new Date(t.time * 1000).toISOString(),
        type: t.type, btc,
        usd: t.type === 'buy' ? cost + fee : cost - fee,
        fee, price: parseFloat(t.price),
      });
    }
    ofs += entries.length;
    if (entries.length === 0 || ofs >= (result.count || 0)) break;
    await sleep(PAGE_DELAY_MS);
  }
  return trades;
}
const isBtcAsset = (a: string) => a === 'XXBT' || a === 'XBT' || a.startsWith('XBT.') || a.startsWith('XXBT.');
const isUsdAsset = (a: string) => ['ZUSD', 'USD', 'USDT', 'USDC'].includes(a) || a.startsWith('ZUSD.') || a.startsWith('USD.');

// Full account ledger, turned into buys/sells and transfers.
//
// Kraken's Instant Buy / recurring-purchase feature does NOT appear in
// TradesHistory — each purchase is a pair of ledger entries sharing a
// refid: a fiat `spend` and a BTC `receive` (a sale is the mirror image).
// Orderbook trades appear in the ledger as type `trade` and are skipped
// here because TradesHistory already covers them.
// Crawl a time window of the ledger newest-first, spending at most
// `budget` pages. Rate-limit exhaustion returns what was collected so far
// instead of throwing — the caller persists a cursor and resumes later.
async function crawlLedger(creds: any, startSec: number, endSec: number, budget: number) {
  const rows: any[] = [];
  let ofs = 0, pagesUsed = 0, exhausted = false;
  try {
    while (pagesUsed < budget) {
      const params: Record<string, string> = { ofs: String(ofs) };
      if (startSec > 0) params.start = String(startSec);
      if (endSec > 0) params.end = String(endSec);
      const result = await krakenPrivate(creds, 'Ledgers', params);
      pagesUsed++;
      const entries = Object.entries(result.ledger || {});
      for (const [lid, l] of entries as [string, any][]) rows.push({ lid, ...l });
      ofs += entries.length;
      if (entries.length === 0 || ofs >= (result.count || 0)) { exhausted = true; break; }
      await sleep(PAGE_DELAY_MS);
    }
  } catch (err: any) {
    if (!err.rateLimited) throw err;
  }
  return { rows, exhausted, pagesUsed };
}

function parseLedgerRows(rows: any[]) {
  const trades: any[] = [];
  const transfers: any[] = [];
  const byRefid = new Map<string, any[]>();
  for (const row of rows) {
    if (row.type === 'withdrawal' || row.type === 'deposit') {
      if (!isBtcAsset(row.asset)) continue; // fiat funding in/out is not a BTC transfer
      transfers.push({
        id: `kraken:${row.lid}`, source: 'kraken',
        date: new Date(row.time * 1000).toISOString(),
        type: row.type === 'withdrawal' ? 'send' : 'receive',
        btc: Math.abs(parseFloat(row.amount)),
        networkFeeBtc: parseFloat(row.fee) || 0,
      });
    } else if (row.type === 'spend' || row.type === 'receive') {
      if (!byRefid.has(row.refid)) byRefid.set(row.refid, []);
      byRefid.get(row.refid)!.push(row);
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
async function fetchKrakenBalance(creds: any) {
  const result = await krakenPrivate(creds, 'Balance');
  let btc = 0;
  for (const [asset, amount] of Object.entries(result) as [string, string][]) {
    if (asset === 'XXBT' || asset === 'XBT' || asset.startsWith('XBT.')) btc += parseFloat(amount);
  }
  return btc;
}
const krakenConfigured = (c: any) => Boolean(c?.key && c?.secret);

// ── Coinbase client (CDP key JWT: ES256 PEM or Ed25519 base64) ──────────
const CB_HOST = 'api.coinbase.com';
function extractEcPrivateKey(der: Uint8Array) {
  // Both SEC1 and PKCS8-wrapped EC keys carry the scalar as the first
  // 32-byte OCTET STRING (04 20 <key>).
  for (let i = 2; i < der.length - 33; i++) {
    if (der[i] === 0x04 && der[i + 1] === 0x20) return der.slice(i + 2, i + 34);
  }
  throw new Error('Could not parse Coinbase EC private key');
}
function buildCoinbaseJwt(creds: any, method: string, pathname: string) {
  const privateKey = (creds.privateKey || '').replace(/\\n/g, '\n');
  const isPem = privateKey.includes('BEGIN');
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: isPem ? 'ES256' : 'EdDSA',
    kid: creds.keyName,
    typ: 'JWT',
    nonce: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
  };
  const payload = { iss: 'cdp', sub: creds.keyName, nbf: now, exp: now + 120, uri: `${method} ${CB_HOST}${pathname}` };
  const signingInput = `${strToB64url(JSON.stringify(header))}.${strToB64url(JSON.stringify(payload))}`;
  let sig: Uint8Array;
  if (isPem) {
    const der = b64ToBytes(privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
    sig = p256.sign(sha256(te.encode(signingInput)), extractEcPrivateKey(der)).toCompactRawBytes();
  } else {
    sig = ed25519.sign(te.encode(signingInput), b64ToBytes(privateKey).slice(0, 32));
  }
  return `${signingInput}.${bytesToB64url(sig)}`;
}
async function cbGet(creds: any, pathWithQuery: string) {
  const pathname = pathWithQuery.split('?')[0];
  const res = await fetch(`https://${CB_HOST}${pathWithQuery}`, {
    headers: {
      Authorization: `Bearer ${buildCoinbaseJwt(creds, 'GET', pathname)}`,
      'CB-VERSION': '2024-01-01',
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = body?.errors?.[0]?.message || JSON.stringify(body).slice(0, 200);
    throw new Error(`Coinbase ${pathname}: HTTP ${res.status} ${msg}`);
  }
  return body;
}
async function cbGetAll(creds: any, firstPath: string) {
  const items: any[] = [];
  let next: string | null = firstPath;
  while (next) {
    const body = await cbGet(creds, next);
    items.push(...(body.data || []));
    next = body.pagination?.next_uri || null;
    if (next) await sleep(350);
  }
  return items;
}
const num = (v: any) => parseFloat(v?.amount ?? v ?? 0) || 0;
async function fetchCoinbaseHistory(creds: any) {
  const trades: any[] = [];
  const transfers: any[] = [];
  let balance = 0;
  const accounts = (await cbGetAll(creds, '/v2/accounts?limit=100')).filter(
    (a: any) => a.currency?.code === 'BTC' || a.currency === 'BTC'
  );
  for (const account of accounts) {
    balance += num(account.balance);
    const feeTotals = new Map<string, number>();
    for (const kind of ['buys', 'sells']) {
      try {
        for (const item of await cbGetAll(creds, `/v2/accounts/${account.id}/${kind}?limit=100`)) {
          if (item.transaction?.id) feeTotals.set(item.transaction.id, Math.abs(num(item.total)));
        }
      } catch { /* older accounts may 404 these; native_amount fallback covers it */ }
    }
    for (const t of await cbGetAll(creds, `/v2/accounts/${account.id}/transactions?limit=100`)) {
      const btc = Math.abs(num(t.amount));
      if (!btc) continue;
      const nativeUsd = Math.abs(num(t.native_amount));
      const id = `coinbase:${t.id}`;
      if (t.type === 'buy' || t.type === 'sell' || t.type === 'trade' || t.type === 'advanced_trade_fill') {
        const isBuy = num(t.amount) > 0;
        let usd = feeTotals.get(t.id) ?? nativeUsd;
        const commission = Math.abs(num(t.advanced_trade_fill?.commission));
        if (commission && !feeTotals.has(t.id)) usd = isBuy ? usd + commission : usd - commission;
        trades.push({
          id, source: 'coinbase', date: t.created_at,
          type: isBuy ? 'buy' : 'sell', btc, usd,
          fee: commission || Math.max(0, feeTotals.has(t.id) ? feeTotals.get(t.id)! - nativeUsd : 0),
          price: btc ? nativeUsd / btc : 0,
        });
      } else if (['send', 'pro_withdrawal', 'exchange_withdrawal', 'receive', 'pro_deposit', 'exchange_deposit'].includes(t.type)) {
        transfers.push({
          id, source: 'coinbase', date: t.created_at,
          type: num(t.amount) < 0 ? 'send' : 'receive', btc, networkFeeBtc: 0,
        });
      }
    }
  }
  return { trades, transfers, balance };
}
const coinbaseConfigured = (c: any) => Boolean(c?.keyName && c?.privateKey);

// ── On-chain (Phantom) & prices ──────────────────────────────────────────
async function fetchOnchainBalance(addresses: string[]) {
  let sats = 0;
  const perAddress: any[] = [];
  for (const address of addresses) {
    const stats = await fetchJson(`https://mempool.space/api/address/${encodeURIComponent(address)}`);
    const confirmed = stats.chain_stats.funded_txo_sum - stats.chain_stats.spent_txo_sum;
    const pending = stats.mempool_stats.funded_txo_sum - stats.mempool_stats.spent_txo_sum;
    sats += confirmed + pending;
    perAddress.push({ address, btc: (confirmed + pending) / 1e8 });
  }
  return { btc: sats / 1e8, perAddress };
}
async function fetchCurrentPrice() {
  const body = await fetchJson('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
  const ticker: any = Object.values(body.result || {})[0];
  return parseFloat(ticker.c[0]);
}
async function fetchCandlesCoinbase(startMs: number, endMs: number) {
  const days: Record<string, number> = {};
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
  const body = await fetchJson('https://api.kraken.com/0/public/OHLC?pair=XBTUSD&interval=1440');
  const rows: any[] = (Object.values(body.result).find(Array.isArray) as any[]) || [];
  const days: Record<string, number> = {};
  for (const [time, , , , close] of rows) days[dayKey(time * 1000)] = parseFloat(close);
  return days;
}
async function getDailyPrices(sinceMs: number) {
  const cache = (await kvGet('prices')) || { days: {} };
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
    await kvSet('prices', { updated: new Date().toISOString(), days });
  }
  return days;
}

// ── Sync & dashboard ─────────────────────────────────────────────────────
let syncing = false;
let priceCache = { at: 0, price: 0 };
let onchainCache: { at: number; result: any } = { at: 0, result: null };

async function currentPrice() {
  if (Date.now() - priceCache.at < 60_000 && priceCache.price) return priceCache.price;
  priceCache = { at: Date.now(), price: await fetchCurrentPrice() };
  return priceCache.price;
}
async function onchain(cfg: any) {
  if (!cfg.phantomAddresses.length) return null;
  if (Date.now() - onchainCache.at < 300_000 && onchainCache.result) return onchainCache.result;
  onchainCache = { at: Date.now(), result: await fetchOnchainBalance(cfg.phantomAddresses) };
  return onchainCache.result;
}
function mergeById(existing: any[], incoming: any[]) {
  const map = new Map(existing.map((t) => [t.id, t]));
  for (const t of incoming) map.set(t.id, t);
  return [...map.values()];
}
async function sync() {
  const cfg = await getConfig();
  const cache = (await kvGet('cache')) || { trades: [], transfers: [], balances: {} };
  const errors: string[] = [];
  if (krakenConfigured(cfg.kraken)) {
    try {
      const cutoffSec = cfg.startDate ? Math.floor(new Date(cfg.startDate).getTime() / 1000) : 0;
      const cur = cache.krakenCursor || { newestSec: 0, oldestSec: 0, complete: false };
      const OVERLAP = 3600; // re-fetch an hour of overlap so refid pairs never split
      let budget = 12; // pages per run — keeps a sync well inside the wall clock
      const rows: any[] = [];

      // Top-up anything newer than what we've already ingested.
      if (cur.newestSec) {
        const r = await crawlLedger(cfg.kraken, cur.newestSec - OVERLAP, 0, budget);
        rows.push(...r.rows);
        budget -= r.pagesUsed;
      }
      // Backfill older history down to the cutoff, resuming where we left off.
      if (!cur.complete && budget > 0) {
        const endSec = cur.oldestSec ? cur.oldestSec + OVERLAP : 0;
        const r = await crawlLedger(cfg.kraken, cutoffSec, endSec, budget);
        rows.push(...r.rows);
        if (r.rows.length) cur.oldestSec = Math.min(...r.rows.map((x) => Number(x.time)));
        if (r.exhausted) cur.complete = true;
      }
      if (rows.length) cur.newestSec = Math.max(cur.newestSec, ...rows.map((x) => Number(x.time)));
      cache.krakenCursor = cur;

      const parsed = parseLedgerRows(rows);
      const orderbook = await fetchKrakenTrades(cfg.kraken, Math.max(cutoffSec, cur.oldestSec || 0) || cutoffSec);
      cache.trades = mergeById(cache.trades, [...orderbook, ...parsed.trades]);
      cache.transfers = mergeById(cache.transfers || [], parsed.transfers);
      cache.balances.kraken = await fetchKrakenBalance(cfg.kraken);
      if (!cur.complete) {
        errors.push('Kraken history import is still in progress — refresh in a few minutes for older buys.');
      }
    } catch (err: any) {
      errors.push(`Kraken: ${err.message}`);
    }
  }
  if (coinbaseConfigured(cfg.coinbase)) {
    try {
      const { trades, transfers, balance } = await fetchCoinbaseHistory(cfg.coinbase);
      cache.trades = mergeById(cache.trades, trades);
      cache.transfers = mergeById(cache.transfers || [], transfers);
      cache.balances.coinbase = balance;
    } catch (err: any) {
      errors.push(`Coinbase: ${err.message}`);
    }
  }
  cache.syncedAt = new Date().toISOString();
  cache.errors = errors;
  await kvSet('cache', cache);
  return cache;
}
async function dashboard() {
  const errors: string[] = [];
  const cfg = await getConfig();
  let cache = await kvGet('cache');
  const anyExchange = krakenConfigured(cfg.kraken) || coinbaseConfigured(cfg.coinbase);
  if (!cache && anyExchange && !syncing) {
    syncing = true;
    try { cache = await sync(); } finally { syncing = false; }
  } else if (cache && anyExchange && !syncing) {
    // Stale data self-heals: kick a background re-sync, serve current data now.
    const age = Date.now() - new Date(cache.syncedAt || 0).getTime();
    const staleMs = cache.krakenCursor && !cache.krakenCursor.complete ? 2 * 60 * 1000 : 60 * 60 * 1000;
    if (age > staleMs && typeof (globalThis as any).EdgeRuntime !== 'undefined') {
      syncing = true;
      (globalThis as any).EdgeRuntime.waitUntil(sync().catch(() => {}).finally(() => { syncing = false; }));
    }
  }
  const settingsManual = normalizeManual(cfg.manual, 'settings-manual');
  errors.push(...(cache?.errors || []));
  let trades = [...(cache?.trades || []), ...settingsManual.trades];
  let transfers = [...(cache?.transfers || []), ...settingsManual.transfers];
  // Optional history cutoff: everything before this date is ignored.
  const startMs = cfg.startDate ? new Date(cfg.startDate).getTime() : 0;
  if (startMs) {
    trades = trades.filter((t: any) => new Date(t.date).getTime() >= startMs);
    transfers = transfers.filter((t: any) => new Date(t.date).getTime() >= startMs);
  }
  const balances = { ...(cache?.balances || {}) };
  let onchainResult = null;
  try {
    onchainResult = await onchain(cfg);
    if (onchainResult) balances.onchain = onchainResult.btc;
  } catch (err: any) {
    errors.push(`On-chain lookup: ${err.message}`);
  }
  const price = await currentPrice();
  const demo = trades.length === 0 && !anyExchange;
  const firstTs = trades.length
    ? Math.min(...trades.map((t: any) => new Date(t.date).getTime()))
    : Date.now() - 1200 * DAY_MS;
  const dailyPrices = await getDailyPrices(firstTs - DAY_MS);
  if (demo) {
    const sample = buildSampleData(dailyPrices, price);
    trades = sample.trades;
    transfers = sample.transfers;
    Object.assign(balances, sample.balances);
  }
  const portfolio = computePortfolio({ trades, transfers, dailyPrices, currentPrice: price, balances });
  return {
    ...portfolio,
    onchainAddresses: onchainResult?.perAddress || [],
    status: {
      demo,
      syncing,
      syncedAt: cache?.syncedAt || null,
      backfilling: Boolean(anyExchange && cache?.krakenCursor && !cache.krakenCursor.complete),
      sources: {
        kraken: krakenConfigured(cfg.kraken),
        coinbase: coinbaseConfigured(cfg.coinbase),
        phantom: cfg.phantomAddresses.length > 0,
        csvOrManual: cfg.manual.length > 0,
      },
      errors,
    },
  };
}

// ── HTTP routing ─────────────────────────────────────────────────────────
// Static UI may be hosted on another origin (e.g. GitHub Pages). Auth rides
// the Authorization header (never ambient cookies), so a permissive origin
// does not enable CSRF; the token is still required for every request.
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '86400',
};
const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS, ...headers } });
const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
};
function asset(name: string) {
  let body = ASSETS[name];
  const ext = name.split('.').pop()!;
  if (ext === 'html') body = body.replace('<head>', `<head><base href="${EXT_BASE}">`);
  return new Response(body, { headers: { 'content-type': CONTENT_TYPES[ext] } });
}

Deno.serve(async (req: Request) => {
  const url = new URL(req.url);
  let p = url.pathname.replace(/^\/functions\/v1/, '').replace(new RegExp(`^/${FN_NAME}`), '');
  if (p === '' || p === '/') p = '/';
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

  try {
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (p === '/healthz') return json({ ok: true });

    if (p === '/api/auth/status') {
      const rec = await getAuthRecord();
      return json({
        username: USERNAME,
        configured: Boolean(rec.hash),
        authed: await verifyToken(tokenFromRequest(req)),
      });
    }
    if (p === '/api/auth/setup' && req.method === 'POST') {
      const rec = await getAuthRecord();
      if (rec.hash) return json({ error: 'Password is already set' }, 409);
      try {
        const body = await req.json().catch(() => ({}));
        await setPassword(body?.password);
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
      const token = await issueToken();
      return json({ ok: true, token }, 200, { 'set-cookie': cookieHeader(token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/auth/login' && req.method === 'POST') {
      const rec = await getAuthRecord();
      if (!rec.hash) return json({ error: 'No password set yet — reload to run first-time setup' }, 409);
      if (!loginAllowed(ip)) return json({ error: 'Too many attempts — try again in 15 minutes' }, 429);
      const body = await req.json().catch(() => ({}));
      const ok = await verifyPassword(body?.username || '', body?.password || '');
      recordLogin(ip, ok);
      if (!ok) return json({ error: 'Wrong username or password' }, 401);
      const token = await issueToken();
      return json({ ok: true, token }, 200, { 'set-cookie': cookieHeader(token, SESSION_DAYS * 86400) });
    }
    if (p === '/api/auth/logout' && req.method === 'POST') {
      return json({ ok: true }, 200, { 'set-cookie': cookieHeader('', 0) });
    }

    // Passkey (Face ID) unlock — public half: mint a session from a passkey.
    if (p === '/api/webauthn/login-options' && req.method === 'POST') {
      try {
        const rec = (await kvGet('webauthn')) || { credentials: [], challenge: null };
        const options = await webauthn.authOptions(rec, req.headers.get('origin') || '');
        await kvSet('webauthn', rec);
        return json(options);
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
    }
    if (p === '/api/webauthn/login' && req.method === 'POST') {
      if (!loginAllowed(ip)) return json({ error: 'Too many attempts — try again in 15 minutes' }, 429);
      try {
        const rec = (await kvGet('webauthn')) || { credentials: [], challenge: null };
        await webauthn.verifyAuth(rec, req.headers.get('origin') || '', await req.json().catch(() => ({})));
        await kvSet('webauthn', rec);
        recordLogin(ip, true);
        const token = await issueToken();
        return json({ ok: true, token }, 200, { 'set-cookie': cookieHeader(token, SESSION_DAYS * 86400) });
      } catch (err: any) {
        recordLogin(ip, false);
        return json({ error: err.message }, 401);
      }
    }
    if (p === '/login' || p === '/login.html') return asset('login.html');
    if (p === '/config.js') return asset('config.js');

    // Scheduled sync (pg_cron -> pg_net). Auth: shared secret from the
    // state table, so the dashboard stays fresh without any page loads.
    if (p === '/api/cron-sync' && req.method === 'POST') {
      const cron = (await kvGet('cron')) || {};
      const given = req.headers.get('x-cron-secret') || '';
      if (!cron.secret || !timingEqual(te.encode(given.padEnd(64).slice(0, 64)), te.encode(String(cron.secret).padEnd(64).slice(0, 64)))) {
        return json({ error: 'unauthorized' }, 401);
      }
      const cache = await kvGet('cache');
      const age = Date.now() - new Date(cache?.syncedAt || 0).getTime();
      const incomplete = !cache || (cache.krakenCursor && !cache.krakenCursor.complete);
      if (!incomplete && age < 55 * 60 * 1000) return json({ skipped: 'fresh' });
      const lock = (await kvGet('syncLock')) || {};
      if (lock.until && Date.now() < lock.until) return json({ skipped: 'locked' });
      await kvSet('syncLock', { until: Date.now() + 4 * 60 * 1000 });
      const run = sync().catch(() => {}).finally(() => kvSet('syncLock', { until: 0 }).catch(() => {}));
      if (typeof (globalThis as any).EdgeRuntime !== 'undefined') {
        (globalThis as any).EdgeRuntime.waitUntil(run);
        return json({ started: true }, 202);
      }
      await run;
      return json({ started: true, completed: true });
    }

    // Everything below requires a session.
    if (!(await verifyToken(tokenFromRequest(req)))) {
      if (p.startsWith('/api/')) return json({ error: 'Not signed in' }, 401);
      return asset('login.html');
    }

    if (p === '/' || p === '/index.html') return asset('index.html');
    if (p === '/app.js' || p === '/style.css') return asset(p.slice(1));

    // Passkey (Face ID) unlock — authenticated half: manage the passkey.
    if (p === '/api/webauthn/status') {
      const rec = (await kvGet('webauthn')) || {};
      return json({ enabled: webauthn.hasPasskey(rec) });
    }
    if (p === '/api/webauthn/register-options' && req.method === 'POST') {
      try {
        const rec = (await kvGet('webauthn')) || { credentials: [], challenge: null };
        const options = await webauthn.registerOptions(rec, req.headers.get('origin') || '', USERNAME);
        await kvSet('webauthn', rec);
        return json(options);
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
    }
    if (p === '/api/webauthn/register' && req.method === 'POST') {
      try {
        const rec = (await kvGet('webauthn')) || { credentials: [], challenge: null };
        await webauthn.verifyRegister(rec, req.headers.get('origin') || '', await req.json().catch(() => ({})));
        await kvSet('webauthn', rec);
        return json({ ok: true });
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
    }
    if (p === '/api/webauthn/disable' && req.method === 'POST') {
      await kvSet('webauthn', { credentials: [], challenge: null });
      return json({ ok: true });
    }

    if (p === '/api/dashboard') return json(await dashboard());
    if (p === '/api/settings' && req.method === 'GET') return json(await publicSettings());
    if (p === '/api/settings' && req.method === 'POST') {
      const patch = await req.json().catch(() => ({}));
      try {
        if (typeof patch.manual === 'string') {
          patch.manual = patch.manual.trim() ? JSON.parse(patch.manual) : '';
        }
        await saveSettings(patch);
      } catch (err: any) {
        return json({ error: err.message }, 400);
      }
      return json(await publicSettings());
    }
    if (p === '/api/sync' && req.method === 'POST') {
      if (syncing) return json({ error: 'Sync already running' }, 409);
      syncing = true;
      try {
        const cache = await sync();
        return json({ syncedAt: cache.syncedAt, errors: cache.errors, trades: cache.trades.length });
      } finally {
        syncing = false;
      }
    }

    return json({ error: 'Not found' }, 404);
  } catch (err: any) {
    return json({ error: err.message }, 500);
  }
});
