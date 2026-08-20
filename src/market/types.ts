/**
 * ============================================================================
 * THE WIRE CONTRACT
 * ============================================================================
 * This file is the source of truth for everything that crosses the network to
 * a television. It is a mirror of `src/core/types.ts` in the TV app — if you
 * change a field here, change it there in the same commit.
 *
 * Nothing vendor-specific may appear in these shapes. That is the whole point:
 * the TV knows about markets, not about SAHMK or Twelve Data.
 */

export type MarketId = 'saudi' | 'us' | 'crypto';

export type DataStatus = 'live' | 'delayed' | 'simulated' | 'cached' | 'offline';

export type SessionState = 'pre' | 'open' | 'break' | 'closed' | 'post' | 'always';

export interface Instrument {
  id: string;            // `${market}:${symbol}`
  market: MarketId;
  symbol: string;
  nameEn: string;
  nameAr: string;
  sector: string;
  currency: 'USD' | 'SAR';
  marketCap?: number;
}

export interface Quote {
  id: string;
  price: number;
  change: number;
  changePct: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  avgVolume?: number;
  week52High?: number;
  week52Low?: number;
  marketCap?: number;
  peRatio?: number;
  dividendYield?: number;
  spark: number[];
  status: DataStatus;
  ts: number;
}

export interface IndexQuote {
  id: string;
  nameEn: string;
  nameAr: string;
  value: number;
  change: number;
  changePct: number;
  status: DataStatus;
  ts: number;
}

export interface Breadth {
  advancing: number;
  declining: number;
  unchanged: number;
  volume: number;
  upVolume: number;
  downVolume: number;
  newHighs: number;
  newLows: number;
}

export interface MarketSnapshot {
  market: MarketId;
  index?: IndexQuote;
  indices: IndexQuote[];
  breadth: Breadth;
  session: SessionState;
  status: DataStatus;
  ts: number;
}

export type Range = '1D' | '1W' | '1M' | '3M' | '6M' | '1Y' | '5Y';

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

/** Frames pushed down the WebSocket. */
export type ServerFrame =
  | { type: 'hello'; deviceId: string | null; markets: MarketId[]; serverTime: number }
  | { type: 'quotes'; data: Quote[] }
  | { type: 'snapshot'; data: MarketSnapshot }
  | { type: 'config'; data: Record<string, unknown> }   // pushed by a paired phone
  | { type: 'pong'; t: number }
  | { type: 'error'; message: string };

/** Frames a screen or phone sends up. */
export type ClientFrame =
  | { type: 'subscribe'; market?: MarketId; ids: string[] }
  | { type: 'unsubscribe'; ids: string[] }
  | { type: 'ping' };

export const EMPTY_BREADTH: Breadth = {
  advancing: 0,
  declining: 0,
  unchanged: 0,
  volume: 0,
  upVolume: 0,
  downVolume: 0,
  newHighs: 0,
  newLows: 0,
};
