import fs from 'fs';
import path from 'path';
import { readJsonFile } from './util.js';

// ── CSV parsing (quoted fields, commas, CRLF) ───────────────────────────
function parseCsv(text) {
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.some((f) => f !== '')) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.some((f) => f !== '')) rows.push(row);
  return rows;
}

const clean = (s) => (s || '').replace(/[$,]/g, '').trim();
const numval = (s) => Math.abs(parseFloat(clean(s))) || 0;

function rowsToObjects(rows, headerIdx) {
  const headers = rows[headerIdx].map((h) => h.trim().toLowerCase());
  return rows.slice(headerIdx + 1).map((r) => {
    const o = {};
    headers.forEach((h, i) => (o[h] = r[i] ?? ''));
    return o;
  });
}

function findHeaderRow(rows, requiredCols) {
  return rows.findIndex((r) => {
    const lower = r.map((c) => c.trim().toLowerCase());
    return requiredCols.every((col) => lower.some((c) => c.includes(col)));
  });
}

// Header lookup with priority: exact match, then prefix, then substring —
// tried in the order the names are given. Avoids collisions like
// "subtotal".includes("total") stealing the fee-inclusive total column.
const col = (obj, ...names) => {
  const keys = Object.keys(obj);
  for (const n of names) {
    const key =
      keys.find((k) => k === n) ??
      keys.find((k) => k.startsWith(n)) ??
      keys.find((k) => k.includes(n));
    if (key !== undefined) return obj[key];
  }
  return '';
};

// ── Format detection & normalization ────────────────────────────────────
function parseCoinbaseCsv(rows, file) {
  const headerIdx = findHeaderRow(rows, ['timestamp', 'transaction type', 'quantity']);
  if (headerIdx < 0) return null;
  const out = { trades: [], transfers: [] };
  rowsToObjects(rows, headerIdx).forEach((r, i) => {
    if ((col(r, 'asset') || 'BTC').toUpperCase() !== 'BTC') return;
    const kind = col(r, 'transaction type').toLowerCase();
    const btc = numval(col(r, 'quantity'));
    if (!btc) return;
    const date = new Date(col(r, 'timestamp')).toISOString();
    const total = numval(col(r, 'total (inclusive', 'total'));
    const subtotal = numval(col(r, 'subtotal')) || total;
    const fee = numval(col(r, 'fees'));
    const base = { id: `csv:${file}:${i}`, source: 'coinbase-csv' };
    if (kind.includes('buy')) {
      out.trades.push({ ...base, date, type: 'buy', btc, usd: total || subtotal + fee, fee, price: subtotal / btc });
    } else if (kind.includes('sell')) {
      out.trades.push({ ...base, date, type: 'sell', btc, usd: total || subtotal - fee, fee, price: subtotal / btc });
    } else if (kind.includes('send') || kind.includes('withdrawal')) {
      out.transfers.push({ ...base, date, type: 'send', btc, networkFeeBtc: 0 });
    } else if (kind.includes('receive') || kind.includes('deposit')) {
      out.transfers.push({ ...base, date, type: 'receive', btc, networkFeeBtc: 0 });
    }
  });
  return out;
}

function parseKrakenCsv(rows, file) {
  const headerIdx = findHeaderRow(rows, ['pair', 'time', 'type', 'cost', 'vol']);
  if (headerIdx < 0) return null;
  const out = { trades: [], transfers: [] };
  rowsToObjects(rows, headerIdx).forEach((r, i) => {
    const pair = col(r, 'pair').toUpperCase();
    if (!pair.includes('XBT') && !pair.includes('BTC')) return;
    if (!/USD/.test(pair)) return;
    const btc = numval(col(r, 'vol'));
    const cost = numval(col(r, 'cost'));
    const fee = numval(col(r, 'fee'));
    const type = col(r, 'type').toLowerCase();
    if (type !== 'buy' && type !== 'sell') return;
    out.trades.push({
      id: `csv:${file}:${i}`,
      source: 'kraken-csv',
      date: new Date(col(r, 'time')).toISOString(),
      type,
      btc,
      usd: type === 'buy' ? cost + fee : cost - fee,
      fee,
      price: numval(col(r, 'price')),
    });
  });
  return out;
}

function parseGenericCsv(rows, file) {
  const headerIdx = findHeaderRow(rows, ['date', 'type', 'btc']);
  if (headerIdx < 0) return null;
  const out = { trades: [], transfers: [] };
  rowsToObjects(rows, headerIdx).forEach((r, i) => {
    const type = col(r, 'type').toLowerCase();
    const btc = numval(col(r, 'btc'));
    if (!btc) return;
    const entry = {
      id: `csv:${file}:${i}`,
      source: 'csv',
      date: new Date(col(r, 'date')).toISOString(),
      type,
      btc,
    };
    if (type === 'buy' || type === 'sell') {
      const usd = numval(col(r, 'usd'));
      out.trades.push({ ...entry, usd, fee: numval(col(r, 'fee')), price: usd / btc });
    } else if (type === 'send' || type === 'receive') {
      out.transfers.push({ ...entry, networkFeeBtc: 0 });
    }
  });
  return out;
}

// Reads data/imports/*.csv (Coinbase export, Kraken export, or generic
// date,type,btc,usd,fee) and data/manual.json.
export function loadImports() {
  const trades = [];
  const transfers = [];
  const errors = [];

  const dir = path.join(process.cwd(), 'data', 'imports');
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.csv'))) {
      try {
        const rows = parseCsv(fs.readFileSync(path.join(dir, file), 'utf8'));
        const parsed =
          parseKrakenCsv(rows, file) || parseCoinbaseCsv(rows, file) || parseGenericCsv(rows, file);
        if (!parsed) throw new Error('unrecognized CSV format');
        trades.push(...parsed.trades);
        transfers.push(...parsed.transfers);
      } catch (err) {
        errors.push(`CSV ${file}: ${err.message}`);
      }
    }
  }

  const manual = readJsonFile(path.join(process.cwd(), 'data', 'manual.json'), []);
  manual.forEach((m, i) => {
    const btc = Math.abs(parseFloat(m.btc)) || 0;
    if (!btc || !m.date) return;
    const entry = {
      id: `manual:${i}`,
      source: 'manual',
      date: new Date(m.date).toISOString(),
      type: m.type,
      btc,
      note: m.note,
    };
    if (m.type === 'buy' || m.type === 'sell') {
      const usd = Math.abs(parseFloat(m.usd)) || 0;
      trades.push({ ...entry, usd, fee: Math.abs(parseFloat(m.fee)) || 0, price: usd / btc });
    } else if (m.type === 'send' || m.type === 'receive') {
      transfers.push({ ...entry, networkFeeBtc: 0 });
    }
  });

  return { trades, transfers, errors };
}
