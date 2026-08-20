import WebSocket from 'ws';
import { config } from '../../config.js';
import { fetchJson, qs } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { referenceUniverse } from '../reference/index.js';
import { num, pctChange, type VendorAdapter } from '../provider.js';
import { EMPTY_BREADTH, type Candle, type Instrument, type MarketSnapshot, type Quote, type Range } from '../types.js';

/**
 * ============================================================================
 * Binance — crypto, live, free, no key
 * ============================================================================
 * The reason this belongs on the server rather than in the TV app: one socket
 * here feeds every screen you own. A hundred televisions each opening their own
 * connection to Binance is a hundred times the bandwidth, a hundred chances to
 * get rate-limited, and no way to serve a screen whose network blocks the
 * exchange.
 *
 * `!miniTicker@arr` pushes every symbol that traded in the last second, so the
 * cost is one connection regardless of how many instruments we track.
 */
export class BinanceAdapter implements VendorAdapter {
  readonly market = 'crypto' as const;
  readonly id = 'binance';

  private instruments: Instrument[] = [];
  private pairToId = new Map<string, string>();
  private latest = new Map<string, Quote>();
  private ws: WebSocket | null = null;
  private retry = 0;
  private retryTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private onQuotes: ((q: Quote[]) => void) | null = null;
  private pending = new Set<string>();
  private flushTimer: NodeJS.Timeout | null = null;

  async init(): Promise<void> {
    this.instruments = referenceUniverse('crypto');
    for (const i of this.instruments) this.pairToId.set(`${i.symbol}USDT`, i.id);
  }

  listInstruments(): Instrument[] {
    return this.instruments;
  }

  requestsPerPoll(): number {
    return 1; // a single /ticker/24hr call covers every symbol
  }

  async poll(): Promise<{ quotes: Quote[]; snapshot?: MarketSnapshot }> {
    try {
      const { data } = await fetchJson<Array<Record<string, string>>>(
        `${config.BINANCE_REST_URL}/ticker/24hr`,
        { source: 'binance:ticker24hr', timeoutMs: 15_000 },
      );
      for (const row of data) {
        const id = this.pairToId.get(String(row.symbol));
        if (!id) continue;
        const q = this.rowToQuote(id, {
          c: row.lastPrice,
          o: row.openPrice,
          h: row.highPrice,
          l: row.lowPrice,
          v: row.volume,
        });
        if (q) this.latest.set(id, q);
      }
    } catch (err) {
      // Rethrow when we have nothing at all: a market with no data must report
      // OFFLINE, not publish an empty snapshot stamped `live`. With prices
      // already cached we keep serving them and let the engine's failure
      // counter relabel them CACHED.
      log.warn('binance: snapshot failed', { err: String(err), cached: this.latest.size });
      if (!this.latest.size) throw err;
    }
    const quotes = [...this.latest.values()];
    return { quotes, snapshot: this.buildSnapshot(quotes) };
  }

  stream(onQuotes: (q: Quote[]) => void): { stop: () => void } {
    this.onQuotes = onQuotes;
    this.stopped = false;
    this.open();
    this.flushTimer = setInterval(() => this.flush(), 500);
    return { stop: () => this.stop() };
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.retryTimer = null;
    this.flushTimer = null;
    try { this.ws?.close(); } catch { /* already closed */ }
    this.ws = null;
  }

  async getCandles(id: string, range: Range): Promise<Candle[]> {
    const symbol = id.split(':')[1];
    if (!symbol) return [];
    const { interval, limit } = klineParams(range);
    try {
      const { data } = await fetchJson<unknown[][]>(
        `${config.BINANCE_REST_URL}/klines${qs({ symbol: `${symbol}USDT`, interval, limit })}`,
        { source: 'binance:klines' },
      );
      return data.map((r) => ({
        t: Number(r[0]),
        o: Number(r[1]),
        h: Number(r[2]),
        l: Number(r[3]),
        c: Number(r[4]),
        v: Number(r[5]),
      }));
    } catch (err) {
      log.warn('binance: candles failed', { symbol, range, err: String(err) });
      return [];
    }
  }

  // ------------------------------------------------------------- internals

  private open() {
    if (this.stopped) return;
    try {
      this.ws = new WebSocket(config.BINANCE_WS_URL);
    } catch (err) {
      log.warn('binance: socket construction failed', { err: String(err) });
      this.scheduleRetry();
      return;
    }

    this.ws.on('open', () => {
      this.retry = 0;
      log.info('binance: stream open');
    });

    this.ws.on('message', (raw: WebSocket.RawData) => {
      try {
        const arr = JSON.parse(raw.toString()) as Array<Record<string, string>>;
        if (!Array.isArray(arr)) return;
        for (const t of arr) {
          const id = this.pairToId.get(String(t.s));
          if (!id) continue;
          const q = this.rowToQuote(id, t);
          if (q) {
            this.latest.set(id, q);
            this.pending.add(id);
          }
        }
      } catch { /* a malformed frame is not worth a log line every second */ }
    });

    this.ws.on('close', () => {
      this.ws = null;
      if (this.stopped) return;
      log.warn('binance: stream closed, reconnecting');
      this.scheduleRetry();
    });

    this.ws.on('error', (err: Error) => {
      log.warn('binance: stream error', { err: err.message });
    });
  }

  private scheduleRetry() {
    if (this.stopped) return;
    const wait = Math.min(30_000, 1000 * 2 ** this.retry) * (0.7 + Math.random() * 0.6);
    this.retry = Math.min(this.retry + 1, 6);
    this.retryTimer = setTimeout(() => this.open(), wait);
  }

  private flush() {
    if (!this.pending.size || !this.onQuotes) return;
    const batch = [...this.pending].map((id) => this.latest.get(id)).filter((q): q is Quote => !!q);
    this.pending.clear();
    if (batch.length) this.onQuotes(batch);
  }

  private rowToQuote(id: string, t: Record<string, string | undefined>): Quote | null {
    const price = num(t.c);
    const open = num(t.o);
    if (!Number.isFinite(price) || !Number.isFinite(open) || open === 0) return null;
    const inst = this.instruments.find((i) => i.id === id);
    const prev = this.latest.get(id);
    return {
      id,
      price,
      change: price - open,
      changePct: pctChange(price, open),
      open,
      high: num(t.h, price),
      low: num(t.l, price),
      previousClose: open,
      volume: num(t.v, 0),
      avgVolume: prev?.avgVolume,
      marketCap: inst?.marketCap,
      spark: [],
      status: 'live',
      ts: Date.now(),
    };
  }

  private buildSnapshot(quotes: Quote[]): MarketSnapshot {
    const btc = this.latest.get('crypto:BTC');
    const eth = this.latest.get('crypto:ETH');
    let capSum = 0;
    let weighted = 0;
    let advancing = 0;
    let declining = 0;
    let unchanged = 0;
    let volume = 0;

    for (const q of quotes) {
      const cap = q.marketCap ?? 1e9;
      capSum += cap;
      weighted += q.changePct * cap;
      volume += q.volume;
      if (q.changePct > 0.02) advancing++;
      else if (q.changePct < -0.02) declining++;
      else unchanged++;
    }

    const indices = [
      btc && { id: 'crypto:BTC', nameEn: 'BTC', nameAr: 'بيتكوين', value: btc.price, change: btc.change, changePct: btc.changePct, status: 'live' as const, ts: btc.ts },
      eth && { id: 'crypto:ETH', nameEn: 'ETH', nameAr: 'إيثيريوم', value: eth.price, change: eth.change, changePct: eth.changePct, status: 'live' as const, ts: eth.ts },
      { id: 'crypto:TOTAL', nameEn: 'TOTAL CAP', nameAr: 'القيمة السوقية', value: capSum, change: 0, changePct: capSum ? weighted / capSum : 0, status: 'live' as const, ts: Date.now() },
    ].filter(Boolean) as MarketSnapshot['indices'];

    return {
      market: 'crypto',
      index: indices[0],
      indices,
      breadth: { ...EMPTY_BREADTH, advancing, declining, unchanged, volume },
      session: 'always',
      status: 'live',
      ts: Date.now(),
    };
  }
}

function klineParams(r: Range): { interval: string; limit: number } {
  switch (r) {
    case '1D': return { interval: '5m', limit: 288 };
    case '1W': return { interval: '1h', limit: 168 };
    case '1M': return { interval: '4h', limit: 180 };
    case '3M': return { interval: '12h', limit: 180 };
    case '6M': return { interval: '1d', limit: 180 };
    case '1Y': return { interval: '1d', limit: 365 };
    case '5Y': return { interval: '1w', limit: 260 };
  }
}
