import path from 'path';
import { readJsonFile, writeJsonFile } from './util.js';

const SETTINGS_FILE = path.join(process.cwd(), 'data', 'settings.json');

const SECRET_FIELDS = ['krakenKey', 'krakenSecret', 'coinbaseKeyName', 'coinbasePrivateKey'];
const FIELDS = [...SECRET_FIELDS, 'phantomAddresses', 'manual', 'startDate'];

export function loadSettings() {
  return readJsonFile(SETTINGS_FILE, {});
}

// Merge a partial update. Empty string clears a field; absent leaves it.
export function saveSettings(patch) {
  const settings = loadSettings();
  for (const field of FIELDS) {
    if (!(field in patch)) continue;
    const v = patch[field];
    if (v === '' || v == null) delete settings[field];
    else settings[field] = v;
  }
  if (settings.manual && !Array.isArray(settings.manual)) {
    throw new Error('manual must be a JSON array of {date, type, btc, usd} entries');
  }
  writeJsonFile(SETTINGS_FILE, settings);
  return settings;
}

// Effective config: environment variables win over dashboard-saved settings.
export function getConfig() {
  const s = loadSettings();
  const addresses = process.env.PHANTOM_BTC_ADDRESSES || s.phantomAddresses || '';
  return {
    kraken: {
      key: process.env.KRAKEN_API_KEY || s.krakenKey || '',
      secret: process.env.KRAKEN_API_SECRET || s.krakenSecret || '',
    },
    coinbase: {
      keyName: process.env.COINBASE_API_KEY_NAME || s.coinbaseKeyName || '',
      privateKey: process.env.COINBASE_API_PRIVATE_KEY || s.coinbasePrivateKey || '',
    },
    phantomAddresses: addresses.split(',').map((a) => a.trim()).filter(Boolean),
    manual: Array.isArray(s.manual) ? s.manual : [],
    startDate: s.startDate || '',
  };
}

// What the settings panel is allowed to see: presence, never values.
export function publicSettings() {
  const cfg = getConfig();
  return {
    kraken: Boolean(cfg.kraken.key && cfg.kraken.secret),
    coinbase: Boolean(cfg.coinbase.keyName && cfg.coinbase.privateKey),
    phantomAddresses: cfg.phantomAddresses.join(', '),
    manualCount: cfg.manual.length,
    startDate: cfg.startDate,
  };
}
