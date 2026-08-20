import type { Candle, Instrument, MarketId, MarketSnapshot, Quote, Range } from './types.js';

/**
 * Server-side vendor adapter.
 *
 * Deliberately narrower than the TV-side `MarketDataProvider`: an adapter here
 * only has to *fetch and normalise*. Caching, fan-out, scheduling, budgeting
 * and session awareness all live in the engine, so every new vendor is a small,
 * boring file rather than another copy of the hard parts.
 */
export interface VendorAdapter {
  readonly market: MarketId;
  readonly id: string;

  /** Called once at boot. Load the tradable universe, warm anything expensive. */
  init(): Promise<void>;

  listInstruments(): Instrument[];

  /**
   * One refresh cycle. Return only what changed if the vendor supports it,
   * otherwise return everything — the engine diffs before it fans out.
   */
  poll(): Promise<{ quotes: Quote[]; snapshot?: MarketSnapshot }>;

  /** How many upstream requests one `poll()` costs. Used for budgeting. */
  requestsPerPoll(): number;

  /** On-demand history for Focus Mode. */
  getCandles(id: string, range: Range): Promise<Candle[]>;

  /**
   * Optional live stream. When present the engine uses it instead of polling
   * and calls `poll()` only to seed and to recover.
   */
  stream?(onQuotes: (q: Quote[]) => void): { stop: () => void };

  stop?(): void;
}

/** Utility every adapter needs: build the canonical instrument id. */
export function idFor(market: MarketId, symbol: string): string {
  return `${market}:${symbol}`;
}

export function num(v: unknown, fallback = NaN): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : fallback;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

/** Percent change, guarding against a zero or missing previous close. */
export function pctChange(price: number, previousClose: number): number {
  if (!Number.isFinite(price) || !Number.isFinite(previousClose) || previousClose === 0) return 0;
  return ((price - previousClose) / previousClose) * 100;
}
