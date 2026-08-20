import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, isProd } from '../config.js';
import { log } from '../lib/logger.js';

/**
 * Device tokens.
 *
 * A television is not a person: it can't type a password, it has no keychain,
 * and it is often in a room other people walk through. So it gets a bearer
 * token minted at pairing, scoped to one device, that proves nothing except
 * "this screen is allowed to read market data and its own settings".
 *
 * Deliberately a compact signed token rather than a JWT library: three fields,
 * one HMAC, no algorithm-confusion surface, no dependency.
 *
 *   base64url({ sub, kind, exp }) . base64url(HMAC-SHA256)
 */

export type TokenKind = 'device' | 'remote';

export interface TokenPayload {
  /** Device id the token is bound to. */
  sub: string;
  kind: TokenKind;
  /** Expiry, epoch seconds. */
  exp: number;
}

const DEFAULT_TTL_SECONDS = 90 * 24 * 3600; // a TV should not need re-pairing every week

let secret = config.TOKEN_SECRET;

if (!secret) {
  if (isProd) {
    throw new Error(
      'TOKEN_SECRET is required in production. Generate one with: openssl rand -hex 32',
    );
  }
  secret = randomBytes(32).toString('hex');
  log.warn('TOKEN_SECRET not set — generated an ephemeral one. Tokens will not survive a restart.');
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString('base64url');
}

function sign(body: string): string {
  return createHmac('sha256', secret).update(body).digest('base64url');
}

export function issueToken(sub: string, kind: TokenKind = 'device', ttlSeconds = DEFAULT_TTL_SECONDS): string {
  const payload: TokenPayload = {
    sub,
    kind,
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const body = b64url(JSON.stringify(payload));
  return `${body}.${sign(body)}`;
}

export function verifyToken(token: string | undefined | null): TokenPayload | null {
  if (!token) return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;

  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);
  const expected = sign(body);

  // Constant-time compare — a token check that leaks timing is a token check
  // that can be brute-forced byte by byte.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as TokenPayload;
    if (!payload.sub || typeof payload.exp !== 'number') return null;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function bearerFrom(headers: Record<string, unknown>): string | null {
  const raw = headers.authorization;
  if (typeof raw !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1] : null;
}

/** Human-typable pairing code. Avoids 0/O and 1/I; digits only keeps it TV-friendly. */
export function pairingCode(length = 4): string {
  const digits = '0123456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += digits[bytes[i] % digits.length];
  return out;
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString('hex')}`;
}
