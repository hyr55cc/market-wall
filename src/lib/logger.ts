import { config } from '../config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof LEVELS;

const threshold = LEVELS[config.LOG_LEVEL as Level] ?? LEVELS.info;

/**
 * Structured logging, one JSON object per line — which is what Railway,
 * Render, CloudWatch and friends all parse for free.
 *
 * `redact` strips anything that looks like a credential before it can reach a
 * log aggregator. Vendor keys leaking into logs is one of the easiest ways to
 * lose a market data licence.
 */
const SECRET_KEYS = /(api[-_]?key|apikey|token|secret|password|authorization)/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (typeof value === 'string') {
    return value.length > 512 ? `${value.slice(0, 512)}…` : value;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: Level, msg: string, meta?: Record<string, unknown>) {
  if (LEVELS[level] < threshold) return;
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta ? (redact(meta) as Record<string, unknown>) : {}),
  };
  const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  out.write(`${JSON.stringify(line)}\n`);
}

export const log = {
  debug: (msg: string, meta?: Record<string, unknown>) => emit('debug', msg, meta),
  info: (msg: string, meta?: Record<string, unknown>) => emit('info', msg, meta),
  warn: (msg: string, meta?: Record<string, unknown>) => emit('warn', msg, meta),
  error: (msg: string, meta?: Record<string, unknown>) => emit('error', msg, meta),
};
