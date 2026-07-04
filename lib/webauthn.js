// Passkey (WebAuthn) support for the Face ID app lock. Storage-agnostic:
// callers load/persist the single-user record { credentials: [], challenge }.
// Runs on both Node (server.js) and Deno (edge function) — build-edge.mjs
// rewrites the import specifier below to its npm: form.
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';

const RP_NAME = 'Bitcoin Tracker';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
// Origins the passkey ceremony may run on: the live site plus local dev.
const ORIGIN_OK = /^https:\/\/richacarson\.github\.io$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

function rpFromOrigin(origin) {
  if (!ORIGIN_OK.test(origin || '')) throw new Error('This origin is not allowed to use passkeys');
  return new URL(origin).hostname;
}

const b64uToBytes = (s) =>
  Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const bytesToB64u = (b) =>
  btoa(Array.from(b, (c) => String.fromCharCode(c)).join('')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function takeChallenge(rec, type) {
  const ch = rec.challenge;
  rec.challenge = null;
  if (!ch || ch.type !== type || Date.now() > ch.expires) {
    throw new Error('Challenge missing or expired — try again');
  }
  return ch.value;
}

export const hasPasskey = (rec) => (rec.credentials || []).length > 0;

// Mutates rec (stores the pending challenge); caller persists rec after.
export async function registerOptions(rec, origin, username) {
  const rpID = rpFromOrigin(origin);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID,
    userName: username,
    authenticatorSelection: {
      authenticatorAttachment: 'platform', // Face ID / Touch ID, not USB keys
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: (rec.credentials || []).map((c) => ({ id: c.id, transports: c.transports })),
  });
  rec.challenge = { value: options.challenge, type: 'reg', expires: Date.now() + CHALLENGE_TTL_MS };
  return options;
}

export async function verifyRegister(rec, origin, response) {
  const rpID = rpFromOrigin(origin);
  const expectedChallenge = takeChallenge(rec, 'reg');
  const v = await verifyRegistrationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    requireUserVerification: true,
  });
  if (!v.verified || !v.registrationInfo) throw new Error('Passkey registration failed verification');
  const c = v.registrationInfo.credential;
  rec.credentials = [
    ...(rec.credentials || []).filter((x) => x.id !== c.id),
    {
      id: c.id,
      publicKey: bytesToB64u(c.publicKey),
      counter: c.counter,
      transports: c.transports || [],
      addedAt: new Date().toISOString(),
    },
  ];
}

export async function authOptions(rec, origin) {
  const rpID = rpFromOrigin(origin);
  if (!hasPasskey(rec)) throw new Error('No passkey registered');
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: rec.credentials.map((c) => ({ id: c.id, transports: c.transports })),
  });
  rec.challenge = { value: options.challenge, type: 'auth', expires: Date.now() + CHALLENGE_TTL_MS };
  return options;
}

export async function verifyAuth(rec, origin, response) {
  const rpID = rpFromOrigin(origin);
  const expectedChallenge = takeChallenge(rec, 'auth');
  const cred = (rec.credentials || []).find((c) => c.id === response?.id);
  if (!cred) throw new Error('Unknown passkey — it may have been removed');
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge,
    expectedOrigin: origin,
    expectedRPID: rpID,
    credential: {
      id: cred.id,
      publicKey: b64uToBytes(cred.publicKey),
      counter: cred.counter || 0,
      transports: cred.transports,
    },
    requireUserVerification: true,
  });
  if (!v.verified) throw new Error('Face ID verification failed');
  cred.counter = v.authenticationInfo.newCounter;
}
