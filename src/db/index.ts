import pg from 'pg';
import { config } from '../config.js';
import { log } from '../lib/logger.js';

/**
 * Postgres, optional.
 *
 * Market data does not need a database — it is ephemeral by nature and lives in
 * the quote store. What needs Postgres is the *account* side: paired devices,
 * watchlists, alerts, cloud sync. So the server boots and serves a full market
 * wall with no DATABASE_URL at all, and simply reports those features as
 * unavailable rather than crashing on startup.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id           TEXT PRIMARY KEY,
  email        TEXT UNIQUE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS devices (
  id           TEXT PRIMARY KEY,
  user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
  name         TEXT NOT NULL DEFAULT 'TV',
  platform     TEXT NOT NULL DEFAULT 'unknown',
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Short-lived pairing handshakes. Rows are disposable by design.
CREATE TABLE IF NOT EXISTS pairing_sessions (
  code         TEXT PRIMARY KEY,
  device_id    TEXT NOT NULL,
  claimed      BOOLEAN NOT NULL DEFAULT false,
  claimed_at   TIMESTAMPTZ,
  expires_at   TIMESTAMPTZ NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pairing_expires_idx ON pairing_sessions (expires_at);

CREATE TABLE IF NOT EXISTS settings (
  device_id    TEXT PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS watchlists (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,          -- device id or user id
  owner_kind   TEXT NOT NULL,          -- 'device' | 'user'
  name         TEXT NOT NULL,
  instrument_ids TEXT[] NOT NULL DEFAULT '{}',
  position     INTEGER NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS watchlists_owner_idx ON watchlists (owner_kind, owner_id);

CREATE TABLE IF NOT EXISTS alerts (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  owner_kind    TEXT NOT NULL,
  instrument_id TEXT NOT NULL,
  kind          TEXT NOT NULL,         -- above | below | pctUp | pctDown | volume
  value         DOUBLE PRECISION NOT NULL,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  fired_at      TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS alerts_owner_idx ON alerts (owner_kind, owner_id);
`;

let pool: pg.Pool | null = null;

export async function initDb(): Promise<boolean> {
  if (!config.DATABASE_URL) {
    log.info('no DATABASE_URL — pairing, watchlists and cloud sync are disabled');
    return false;
  }
  try {
    pool = new pg.Pool({
      connectionString: config.DATABASE_URL,
      max: 8,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 8_000,
      // Managed Postgres (Railway, Render, Supabase) terminates TLS with its
      // own CA; verifying it needs the provider's root, which we don't ship.
      ssl: /sslmode=require|\.railway\.|\.render\.com|supabase/.test(config.DATABASE_URL)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    await pool.query(SCHEMA);
    log.info('postgres ready');
    return true;
  } catch (err) {
    log.error('postgres unavailable — continuing without it', { err: String(err) });
    pool = null;
    return false;
  }
}

export function db(): pg.Pool | null {
  return pool;
}

export function dbReady(): boolean {
  return pool !== null;
}

export async function closeDb(): Promise<void> {
  await pool?.end().catch(() => undefined);
  pool = null;
}

/** Small helper so routes don't repeat the null check. */
export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const p = pool;
  if (!p) throw new Error('database not configured');
  const res = await p.query<T>(text, params as never[]);
  return res.rows;
}
