import crypto from 'crypto';
import { sleep } from './util.js';

const HOST = 'api.coinbase.com';

// CDP API keys come in two flavors: ECDSA (PEM "BEGIN EC PRIVATE KEY" block,
// signs ES256) and Ed25519 (a base64 string, signs EdDSA). Support both.
function buildJwt(method, pathname) {
  const keyName = process.env.COINBASE_API_KEY_NAME;
  const privateKey = (process.env.COINBASE_API_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  const isPem = privateKey.includes('BEGIN');
  const now = Math.floor(Date.now() / 1000);
  const header = {
    alg: isPem ? 'ES256' : 'EdDSA',
    kid: keyName,
    typ: 'JWT',
    nonce: crypto.randomBytes(16).toString('hex'),
  };
  const payload = {
    iss: 'cdp',
    sub: keyName,
    nbf: now,
    exp: now + 120,
    uri: `${method} ${HOST}${pathname}`,
  };
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const signingInput = `${enc(header)}.${enc(payload)}`;
  let sig;
  if (isPem) {
    sig = crypto.sign('sha256', Buffer.from(signingInput), {
      key: privateKey,
      dsaEncoding: 'ieee-p1363',
    });
  } else {
    const seed = Buffer.from(privateKey, 'base64').subarray(0, 32);
    const pkcs8 = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]);
    const keyObj = crypto.createPrivateKey({ key: pkcs8, format: 'der', type: 'pkcs8' });
    sig = crypto.sign(null, Buffer.from(signingInput), keyObj);
  }
  return `${signingInput}.${sig.toString('base64url')}`;
}

async function cbGet(pathWithQuery) {
  const pathname = pathWithQuery.split('?')[0];
  const res = await fetch(`https://${HOST}${pathWithQuery}`, {
    headers: {
      Authorization: `Bearer ${buildJwt('GET', pathname)}`,
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

async function cbGetAll(firstPath) {
  const items = [];
  let next = firstPath;
  while (next) {
    const body = await cbGet(next);
    items.push(...(body.data || []));
    next = body.pagination?.next_uri || null;
    if (next) await sleep(350);
  }
  return items;
}

async function btcAccounts() {
  const accounts = await cbGetAll('/v2/accounts?limit=100');
  return accounts.filter((a) => a.currency?.code === 'BTC' || a.currency === 'BTC');
}

const num = (v) => parseFloat(v?.amount ?? v ?? 0) || 0;

// Full BTC history from Coinbase, normalized. Buys/sells use the dedicated
// buys/sells resources when available (their `total` is fee-inclusive);
// otherwise fall back to the transaction's native_amount.
export async function fetchCoinbaseHistory() {
  const trades = [];
  const transfers = [];
  let balance = 0;

  for (const account of await btcAccounts()) {
    balance += num(account.balance);

    const feeTotals = new Map(); // linked transaction id -> fee-inclusive USD total
    for (const kind of ['buys', 'sells']) {
      try {
        for (const item of await cbGetAll(`/v2/accounts/${account.id}/${kind}?limit=100`)) {
          if (item.transaction?.id) {
            feeTotals.set(item.transaction.id, Math.abs(num(item.total)));
          }
        }
      } catch {
        // Older accounts may 404 these endpoints; native_amount fallback covers it.
      }
    }

    const txs = await cbGetAll(`/v2/accounts/${account.id}/transactions?limit=100`);
    for (const t of txs) {
      const btc = Math.abs(num(t.amount));
      if (!btc) continue;
      const date = t.created_at;
      const nativeUsd = Math.abs(num(t.native_amount));
      const id = `coinbase:${t.id}`;

      if (t.type === 'buy' || t.type === 'sell' || t.type === 'trade' || t.type === 'advanced_trade_fill') {
        const isBuy = num(t.amount) > 0;
        let usd = feeTotals.get(t.id) ?? nativeUsd;
        const commission = Math.abs(num(t.advanced_trade_fill?.commission));
        if (commission && !feeTotals.has(t.id)) usd = isBuy ? usd + commission : usd - commission;
        trades.push({
          id,
          source: 'coinbase',
          date,
          type: isBuy ? 'buy' : 'sell',
          btc,
          usd,
          fee: commission || Math.max(0, feeTotals.has(t.id) ? feeTotals.get(t.id) - nativeUsd : 0),
          price: btc ? nativeUsd / btc : 0,
        });
      } else if (t.type === 'send' || t.type === 'pro_withdrawal' || t.type === 'exchange_withdrawal' || t.type === 'receive' || t.type === 'pro_deposit' || t.type === 'exchange_deposit') {
        transfers.push({
          id,
          source: 'coinbase',
          date,
          type: num(t.amount) < 0 ? 'send' : 'receive',
          btc,
          networkFeeBtc: 0,
        });
      }
      // Other types (staking rewards, fiat movements, etc.) don't apply to a BTC account.
    }
  }

  return { trades, transfers, balance };
}

export const coinbaseConfigured = () =>
  Boolean(process.env.COINBASE_API_KEY_NAME && process.env.COINBASE_API_PRIVATE_KEY);
