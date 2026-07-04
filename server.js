import 'dotenv/config';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { readJsonFile, writeJsonFile } from './lib/util.js';
import { fetchKrakenTrades, fetchKrakenTransfers, fetchKrakenBalance, krakenConfigured } from './lib/kraken.js';
import { fetchCoinbaseHistory, coinbaseConfigured } from './lib/coinbase.js';
import { fetchOnchainBalance } from './lib/onchain.js';
import { getConfig, saveSettings, publicSettings } from './lib/config.js';
import { normalizeManual } from './lib/manual.js';
import { fetchCurrentPrice, getDailyPrices } from './lib/prices.js';
import { loadImports } from './lib/imports.js';
import { computePortfolio } from './lib/costbasis.js';
import { buildSampleData } from './lib/sample.js';
import * as auth from './lib/auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'data', 'cache.json');
const app = express();
app.set('trust proxy', 1); // honor X-Forwarded-Proto behind a hosting proxy
app.use(express.json());

// ── Auth (everything below the public routes requires a session) ────────
app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get(['/login', '/login.html'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

// Assets the login page and home-screen install need before sign-in.
app.get(['/config.js', '/manifest.webmanifest'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', req.path));
});
app.use('/icons', express.static(path.join(__dirname, 'public', 'icons')));

app.get('/api/auth/status', (req, res) => {
  res.json({
    username: auth.username(),
    configured: auth.passwordConfigured(),
    authed: auth.verifyToken(auth.tokenFromRequest(req)),
  });
});

app.post('/api/auth/setup', (req, res) => {
  try {
    if (auth.passwordConfigured()) return res.status(409).json({ error: 'Password is already set' });
    auth.setPassword(req.body?.password);
    const token = auth.issueToken();
    res.setHeader('Set-Cookie', auth.sessionCookie(req, token, 30 * 86400));
    res.json({ ok: true, token });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/login', (req, res) => {
  if (!auth.passwordConfigured()) return res.status(409).json({ error: 'No password set yet — reload to run first-time setup' });
  if (!auth.loginAllowed(req.ip)) return res.status(429).json({ error: 'Too many attempts — try again in 15 minutes' });
  const ok = auth.verifyPassword(req.body?.username || '', req.body?.password || '');
  auth.recordLogin(req.ip, ok);
  if (!ok) return res.status(401).json({ error: 'Wrong username or password' });
  const token = auth.issueToken();
  res.setHeader('Set-Cookie', auth.sessionCookie(req, token, 30 * 86400));
  res.json({ ok: true, token });
});

app.post('/api/auth/logout', (req, res) => {
  res.setHeader('Set-Cookie', auth.sessionCookie(req, '', 0));
  res.json({ ok: true });
});

app.use((req, res, next) => {
  if (auth.verifyToken(auth.tokenFromRequest(req))) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'Not signed in' });
  res.redirect('/login.html');
});

app.use(express.static(path.join(__dirname, 'public')));

let syncing = false;
let priceCache = { at: 0, price: null };
let onchainCache = { at: 0, result: null };

async function currentPrice() {
  if (Date.now() - priceCache.at < 60_000 && priceCache.price) return priceCache.price;
  priceCache = { at: Date.now(), price: await fetchCurrentPrice() };
  return priceCache.price;
}

async function onchain() {
  const addresses = getConfig().phantomAddresses;
  if (!addresses.length) return null;
  if (Date.now() - onchainCache.at < 300_000 && onchainCache.result) return onchainCache.result;
  onchainCache = { at: Date.now(), result: await fetchOnchainBalance(addresses) };
  return onchainCache.result;
}

function mergeById(existing, incoming) {
  const map = new Map(existing.map((t) => [t.id, t]));
  for (const t of incoming) map.set(t.id, t);
  return [...map.values()];
}

// Pull fresh history from every configured exchange. Incremental for
// Kraken (its rate limits make full re-pulls slow); full for Coinbase.
async function sync() {
  const cfg = getConfig();
  const cache = readJsonFile(CACHE_FILE, { trades: [], transfers: [], balances: {} });
  const errors = [];

  if (krakenConfigured(cfg.kraken)) {
    try {
      const lastKraken = cache.trades
        .filter((t) => t.source === 'kraken')
        .reduce((max, t) => Math.max(max, new Date(t.date).getTime()), 0);
      const sinceSec = lastKraken ? Math.floor(lastKraken / 1000) - 86400 : 0;
      cache.trades = mergeById(cache.trades, await fetchKrakenTrades(cfg.kraken, sinceSec));
      cache.transfers = mergeById(cache.transfers || [], await fetchKrakenTransfers(cfg.kraken, sinceSec));
      cache.balances.kraken = await fetchKrakenBalance(cfg.kraken);
    } catch (err) {
      errors.push(`Kraken: ${err.message}`);
    }
  }

  if (coinbaseConfigured(cfg.coinbase)) {
    try {
      const { trades, transfers, balance } = await fetchCoinbaseHistory(cfg.coinbase);
      cache.trades = mergeById(cache.trades, trades);
      cache.transfers = mergeById(cache.transfers || [], transfers);
      cache.balances.coinbase = balance;
    } catch (err) {
      errors.push(`Coinbase: ${err.message}`);
    }
  }

  cache.syncedAt = new Date().toISOString();
  cache.errors = errors;
  writeJsonFile(CACHE_FILE, cache);
  return cache;
}

app.get('/api/dashboard', async (req, res) => {
  try {
    const errors = [];
    const cfg = getConfig();
    let cache = readJsonFile(CACHE_FILE, null);
    const anyExchange = krakenConfigured(cfg.kraken) || coinbaseConfigured(cfg.coinbase);

    // First visit with keys configured: sync inline so the page has data.
    if (!cache && anyExchange && !syncing) {
      syncing = true;
      try { cache = await sync(); } finally { syncing = false; }
    }

    const imports = loadImports();
    const settingsManual = normalizeManual(cfg.manual, 'settings-manual');
    errors.push(...imports.errors, ...(cache?.errors || []));

    let trades = [...(cache?.trades || []), ...imports.trades, ...settingsManual.trades];
    let transfers = [...(cache?.transfers || []), ...imports.transfers, ...settingsManual.transfers];
    const balances = { ...(cache?.balances || {}) };

    let onchainResult = null;
    try {
      onchainResult = await onchain();
      if (onchainResult) balances.onchain = onchainResult.btc;
    } catch (err) {
      errors.push(`On-chain lookup: ${err.message}`);
    }

    const price = await currentPrice();
    const demo = trades.length === 0 && !anyExchange;
    const firstTs = trades.length
      ? Math.min(...trades.map((t) => new Date(t.date).getTime()))
      : Date.now() - 1200 * 86400000;
    const dailyPrices = await getDailyPrices(firstTs - 86400000);

    if (demo) {
      const sample = buildSampleData(dailyPrices, price);
      trades = sample.trades;
      transfers = sample.transfers;
      Object.assign(balances, sample.balances);
    }

    const portfolio = computePortfolio({ trades, transfers, dailyPrices, currentPrice: price, balances });

    res.json({
      ...portfolio,
      onchainAddresses: onchainResult?.perAddress || [],
      status: {
        demo,
        syncing,
        syncedAt: cache?.syncedAt || null,
        sources: {
          kraken: krakenConfigured(cfg.kraken),
          coinbase: coinbaseConfigured(cfg.coinbase),
          phantom: cfg.phantomAddresses.length > 0,
          csvOrManual:
            imports.trades.length + imports.transfers.length + cfg.manual.length > 0,
        },
        errors,
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/settings', (req, res) => {
  res.json(publicSettings());
});

app.post('/api/settings', (req, res) => {
  try {
    const patch = { ...req.body };
    if (typeof patch.manual === 'string') {
      patch.manual = patch.manual.trim() ? JSON.parse(patch.manual) : '';
    }
    saveSettings(patch);
    res.json(publicSettings());
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/sync', async (req, res) => {
  if (syncing) return res.status(409).json({ error: 'Sync already running' });
  syncing = true;
  try {
    const cache = await sync();
    res.json({ syncedAt: cache.syncedAt, errors: cache.errors, trades: cache.trades.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    syncing = false;
  }
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`₿ Bitcoin Tracker running at http://localhost:${port}`);
  const cfg = getConfig();
  const configured = [
    krakenConfigured(cfg.kraken) && 'Kraken',
    coinbaseConfigured(cfg.coinbase) && 'Coinbase',
    cfg.phantomAddresses.length && 'Phantom on-chain',
  ].filter(Boolean);
  console.log(
    configured.length
      ? `Configured sources: ${configured.join(', ')}`
      : 'No sources connected yet — showing demo data. Add keys in the dashboard (Connections) or via .env.'
  );
});
