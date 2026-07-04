import crypto from 'crypto';
import path from 'path';
import { readJsonFile, writeJsonFile } from './util.js';

const AUTH_FILE = path.join(process.cwd(), 'data', 'auth.json');
const COOKIE = 'btctracker_session';
const SESSION_DAYS = 30;

export const username = () => process.env.AUTH_USERNAME || 'richacarson';

function record() {
  return readJsonFile(AUTH_FILE, {});
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const rec = record();
  if (!rec.sessionSecret) {
    rec.sessionSecret = crypto.randomBytes(32).toString('hex');
    writeJsonFile(AUTH_FILE, rec);
  }
  return rec.sessionSecret;
}

// Password is configured either via the APP_PASSWORD env var (handy on
// hosts without a persistent disk) or by first-run setup on the login page.
export function passwordConfigured() {
  return Boolean(process.env.APP_PASSWORD || record().hash);
}

export function setPassword(password) {
  if (passwordConfigured()) throw new Error('Password is already set');
  if (typeof password !== 'string' || password.length < 8) {
    throw new Error('Password must be at least 8 characters');
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  writeJsonFile(AUTH_FILE, { ...record(), username: username(), salt, hash });
}

export function verifyPassword(user, password) {
  const userOk = crypto.timingSafeEqual(
    Buffer.from(String(user).toLowerCase().padEnd(64).slice(0, 64)),
    Buffer.from(username().toLowerCase().padEnd(64).slice(0, 64))
  );
  let passOk = false;
  if (process.env.APP_PASSWORD) {
    const want = crypto.createHash('sha256').update(process.env.APP_PASSWORD).digest();
    const got = crypto.createHash('sha256').update(String(password)).digest();
    passOk = crypto.timingSafeEqual(want, got);
  } else {
    const rec = record();
    if (rec.hash && rec.salt) {
      const got = crypto.scryptSync(String(password), rec.salt, 64);
      passOk = crypto.timingSafeEqual(got, Buffer.from(rec.hash, 'hex'));
    }
  }
  return userOk && passOk;
}

// ── Signed session tokens (HMAC, stateless) ─────────────────────────────
function sign(payload) {
  return crypto.createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function issueToken() {
  const payload = `${username()}.${Date.now() + SESSION_DAYS * 86400000}`;
  return `${Buffer.from(payload).toString('base64url')}.${sign(payload)}`;
}

export function verifyToken(token) {
  if (!token) return false;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return false;
  const payload = Buffer.from(body, 'base64url').toString();
  const expected = sign(payload);
  if (sig.length !== expected.length) return false;
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return false;
  const expires = parseInt(payload.split('.').pop(), 10);
  return Number.isFinite(expires) && Date.now() < expires;
}

export function sessionCookie(req, token, maxAgeSec) {
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  return (
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}` +
    (secure ? '; Secure' : '')
  );
}

export function tokenFromRequest(req) {
  const bearer = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1];
  const cookies = req.headers.cookie || '';
  const match = cookies.split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  return match ? match.slice(COOKIE.length + 1) : null;
}

// ── Brute-force throttle: 8 failures per IP → 15 minute lockout ─────────
const attempts = new Map();
export function loginAllowed(ip) {
  const a = attempts.get(ip);
  return !a || Date.now() > (a.lockedUntil || 0);
}
export function recordLogin(ip, ok) {
  if (ok) { attempts.delete(ip); return; }
  const a = attempts.get(ip) || { fails: 0, lockedUntil: 0 };
  a.fails += 1;
  if (a.fails >= 8) { a.lockedUntil = Date.now() + 15 * 60000; a.fails = 0; }
  attempts.set(ip, a);
}
