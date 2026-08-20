import { z } from 'zod';
import { loadEnvFile } from './lib/env.js';

// Must run before the schema reads process.env. Does nothing when the platform
// already injects variables (Railway, Render, Docker) — see lib/env.ts.
export const envFile = loadEnvFile();

/**
 * Configuration. Every secret lives here and nowhere else — the TV app never
 * sees a vendor key (spec §40).
 *
 * Design note: everything except PORT is optional. The server starts and serves
 * whatever it can: no Redis → in-memory cache; no Postgres → pairing and
 * watchlists are disabled but market data still works; no SAHMK key → the Saudi
 * market is simply absent rather than fabricated. A half-configured deployment
 * degrades honestly instead of failing to boot.
 */

const bool = (d: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v)));

const int = (d: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? d : Number(v)))
    .pipe(z.number().int().positive());

const schema = z.object({
  NODE_ENV: z.string().optional().default('development'),
  PORT: int(8080),
  HOST: z.string().optional().default('0.0.0.0'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).optional().default('info'),

  /** Comma-separated origins allowed to call the API. `*` in development. */
  CORS_ORIGINS: z.string().optional().default('*'),

  /** Signing secret for device tokens. Generate with `openssl rand -hex 32`. */
  TOKEN_SECRET: z.string().optional().default(''),

  DATABASE_URL: z.string().optional().default(''),
  REDIS_URL: z.string().optional().default(''),

  // ---------------------------------------------------------------- SAHMK
  /** Saudi market (TASI/NOMU). https://www.sahmk.sa/en/developers */
  SAHMK_API_KEY: z.string().optional().default(''),
  SAHMK_BASE_URL: z.string().optional().default('https://api.sahmk.sa/api/v1'),
  /**
   * 'delayed' on Free/Starter, 'realtime' on Pro+.
   * This is also a hard ceiling: with 'delayed' the adapter will never mark a
   * quote as live, no matter what the upstream says (spec §57).
   */
  SAHMK_DATA_MODE: z.enum(['delayed', 'realtime']).optional().default('delayed'),
  /** Requests per day your plan allows. Free 100 · Starter 5 000 · Pro 50 000. */
  SAHMK_DAILY_BUDGET: int(100),
  /** Bulk /quotes/ requires Starter or above. Leave false on the Free plan. */
  SAHMK_BULK_QUOTES: bool(false),
  /** Real-time WebSocket requires Pro or above. */
  SAHMK_WEBSOCKET: bool(false),

  // ----------------------------------------------------------- Twelve Data
  /** US equities. https://twelvedata.com/pricing */
  TWELVEDATA_API_KEY: z.string().optional().default(''),
  TWELVEDATA_BASE_URL: z.string().optional().default('https://api.twelvedata.com'),
  /** Credits per day. Basic (free) 800 · Grow and above far higher. */
  TWELVEDATA_DAILY_BUDGET: int(800),
  /**
   * What your Twelve Data entitlement actually is for US equities.
   * Their Basic plan documents real-time US stocks, so 'live' is the default —
   * but if your entitlement is delayed, set this to 'delayed' and the TV will
   * say DELAYED. Same hard ceiling as the Saudi adapter.
   */
  TWELVEDATA_DATA_MODE: z.enum(['live', 'delayed']).optional().default('live'),
  /** Credits per minute your plan allows. Basic 8 · Grow 377 · Pro 1597. */
  TWELVEDATA_PER_MINUTE: int(8),
  /**
   * How many US symbols to track. Each symbol costs 1 credit per refresh, so
   * this and the daily budget together decide the refresh interval.
   */
  TWELVEDATA_SYMBOL_LIMIT: int(24),

  // --------------------------------------------------------------- Binance
  /** Crypto. Public, free, no key. Set to false to disable the market. */
  BINANCE_ENABLED: bool(true),
  BINANCE_REST_URL: z.string().optional().default('https://api.binance.com/api/v3'),
  BINANCE_WS_URL: z.string().optional().default('wss://stream.binance.com:9443/ws/!miniTicker@arr'),

  /**
   * Serve deterministic fake data for any market that has no credentials.
   * Quotes are marked `simulated` and the TV badges them blue — useful for
   * demos and for developing against a market you haven't licensed yet.
   * NEVER enable this in production.
   */
  ALLOW_SIMULATED: bool(false),
});

export type Config = z.infer<typeof schema>;

function load(): Config {
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  return parsed.data;
}

export const config = load();

export const isProd = config.NODE_ENV === 'production';

/** Which markets this deployment can actually serve, and how. */
export function marketPlan() {
  return {
    saudi: config.SAHMK_API_KEY ? 'sahmk' : config.ALLOW_SIMULATED ? 'simulated' : 'disabled',
    us: config.TWELVEDATA_API_KEY ? 'twelvedata' : config.ALLOW_SIMULATED ? 'simulated' : 'disabled',
    crypto: config.BINANCE_ENABLED ? 'binance' : config.ALLOW_SIMULATED ? 'simulated' : 'disabled',
  } as const;
}

export function corsOrigins(): string[] | true {
  const raw = config.CORS_ORIGINS.trim();
  if (!raw || raw === '*') return true;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}
