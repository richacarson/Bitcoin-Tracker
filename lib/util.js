import fs from 'fs';
import path from 'path';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function fetchJson(url, options = {}, { retries = 3, backoffMs = 2000 } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, options);
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${url}: ${text.slice(0, 300)}`);
        err.status = res.status;
        // Retry rate limits and server errors; fail fast on auth errors.
        if (res.status === 429 || res.status >= 500) throw err;
        err.fatal = true;
        throw err;
      }
      return body ?? text;
    } catch (err) {
      lastErr = err;
      if (err.fatal || attempt === retries) break;
      await sleep(backoffMs * Math.pow(2, attempt));
    }
  }
  throw lastErr;
}

export function readJsonFile(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

export const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10);
