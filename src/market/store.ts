import Redis from 'ioredis';
import { config } from '../config.js';
import { log } from '../lib/logger.js';
import type { MarketId, MarketSnapshot, Quote } from './types.js';

/**
 * ============================================================================
 * Quote store
 * ============================================================================
 * Hot state lives in process memory, because that is what a WebSocket fan-out
 * actually reads from and a Redis round-trip per tick would be absurd. Redis is
 * used for what it is good at here:
 *
 *   - surviving a restart, so a screen reconnecting mid-session sees prices
 *     immediately instead of a blank wall
 *   - sharing state across replicas, so scaling to two instances doesn't double
 *     the vendor bill
 *
 * With no REDIS_URL the store still works, just per-process and non-durable.
 * That is a deliberate, documented downgrade — not a silent one.
 */

const SPARK_POINTS = 40;

export class QuoteStore {
  private quotes = new Map<string, Quote>();
  private snapshots = new Map<MarketId, MarketSnapshot>();
  /** Rolling price history per instrument, used to draw sparklines. */
  private sparks = new Map<string, number[]>();
  private redis: Redis | null = null;
  private persistTimer: NodeJS.Timeout | null = null;
  private dirtySincePersist = false;

  async init(): Promise<void> {
    if (config.REDIS_URL) {
      try {
        this.redis = new Redis(config.REDIS_URL, {
          maxRetriesPerRequest: 2,
          lazyConnect: true,
          retryStrategy: (times) => Math.min(30_000, 500 * 2 ** times),
        });
        this.redis.on('error', (err) => log.warn('redis error', { err: err.message }));
        await this.redis.connect();
        await this.restore();
        log.info('redis connected');
      } catch (err) {
        log.warn('redis unavailable, continuing in memory only', { err: String(err) });
        this.redis = null;
      }
    } else {
      log.info('no REDIS_URL — quote cache is in-memory and will not survive a restart');
    }

    this.persistTimer = setInterval(() => void this.persist(), 15_000);
  }

  stop(): void {
    if (this.persistTimer) clearInterval(this.persistTimer);
    this.persistTimer = null;
    void this.redis?.quit().catch(() => undefined);
  }

  /**
   * Merge a vendor payload into the store, attach the rolling sparkline, and
   * return only the quotes that actually changed. That last part is what keeps
   * the WebSocket quiet: a market where three names moved sends three quotes,
   * not four hundred.
   */
  upsert(incoming: Quote[]): Quote[] {
    const changed: Quote[] = [];

    for (const raw of incoming) {
      const prev = this.quotes.get(raw.id);
      const spark = this.pushSpark(raw.id, raw.price, prev?.spark);
      const next: Quote = { ...raw, spark };

      if (prev && !materiallyDifferent(prev, next)) continue;

      // Carry forward fields a partial payload didn't include, so a cheap
      // endpoint that omits 52-week highs doesn't erase them.
      if (prev) {
        next.avgVolume ??= prev.avgVolume;
        next.week52High ??= prev.week52High;
        next.week52Low ??= prev.week52Low;
        next.marketCap ??= prev.marketCap;
        next.peRatio ??= prev.peRatio;
        next.dividendYield ??= prev.dividendYield;
      }

      this.quotes.set(next.id, next);
      changed.push(next);
      this.dirtySincePersist = true;
    }

    return changed;
  }

  setSnapshot(snapshot: MarketSnapshot): void {
    this.snapshots.set(snapshot.market, snapshot);
    this.dirtySincePersist = true;
  }

  /** Mark a market's data as cached — the upstream is down but we still have prices. */
  degrade(market: MarketId): Quote[] {
    const touched: Quote[] = [];
    for (const [id, q] of this.quotes) {
      if (!id.startsWith(`${market}:`)) continue;
      if (q.status === 'cached' || q.status === 'simulated') continue;
      const next = { ...q, status: 'cached' as const };
      this.quotes.set(id, next);
      touched.push(next);
    }
    const snap = this.snapshots.get(market);
    if (snap && snap.status !== 'cached' && snap.status !== 'simulated') {
      this.snapshots.set(market, { ...snap, status: 'cached' });
    }
    return touched;
  }

  get(id: string): Quote | undefined {
    return this.quotes.get(id);
  }

  many(ids: string[]): Quote[] {
    return ids.map((id) => this.quotes.get(id)).filter((q): q is Quote => !!q);
  }

  forMarket(market: MarketId): Quote[] {
    const out: Quote[] = [];
    for (const [id, q] of this.quotes) {
      if (id.startsWith(`${market}:`)) out.push(q);
    }
    return out;
  }

  snapshot(market: MarketId): MarketSnapshot | undefined {
    return this.snapshots.get(market);
  }

  allSnapshots(): MarketSnapshot[] {
    return [...this.snapshots.values()];
  }

  size(): number {
    return this.quotes.size;
  }

  // ------------------------------------------------------------- internals

  private pushSpark(id: string, price: number, previousSpark?: number[]): number[] {
    let series = this.sparks.get(id);
    if (!series) {
      series = previousSpark?.length ? [...previousSpark] : [];
      this.sparks.set(id, series);
    }
    if (!Number.isFinite(price)) return series.slice();
    if (series[series.length - 1] !== price) {
      series.push(price);
      if (series.length > SPARK_POINTS) series.splice(0, series.length - SPARK_POINTS);
    }
    return series.slice();
  }

  private async persist(): Promise<void> {
    if (!this.redis || !this.dirtySincePersist) return;
    this.dirtySincePersist = false;
    try {
      const payload = JSON.stringify({
        ts: Date.now(),
        quotes: [...this.quotes.values()],
        snapshots: [...this.snapshots.values()],
      });
      // Two hours is long enough to survive a deploy, short enough that a
      // forgotten instance can't serve genuinely stale prices.
      await this.redis.set('mw:state:v1', payload, 'EX', 7200);
    } catch (err) {
      log.warn('redis persist failed', { err: String(err) });
    }
  }

  private async restore(): Promise<void> {
    if (!this.redis) return;
    try {
      const raw = await this.redis.get('mw:state:v1');
      if (!raw) return;
      const parsed = JSON.parse(raw) as { ts: number; quotes: Quote[]; snapshots: MarketSnapshot[] };
      const age = Date.now() - parsed.ts;
      for (const q of parsed.quotes) {
        // Anything restored from disk is, by definition, cached — never live.
        this.quotes.set(q.id, { ...q, status: q.status === 'simulated' ? 'simulated' : 'cached' });
        this.sparks.set(q.id, q.spark ?? []);
      }
      for (const s of parsed.snapshots) {
        this.snapshots.set(s.market, { ...s, status: s.status === 'simulated' ? 'simulated' : 'cached' });
      }
      log.info('state restored from redis', { quotes: parsed.quotes.length, ageSeconds: Math.round(age / 1000) });
    } catch (err) {
      log.warn('redis restore failed', { err: String(err) });
    }
  }
}

/**
 * Ignore no-op updates. Vendors happily resend an identical row every cycle;
 * forwarding those would wake every television for nothing.
 */
function materiallyDifferent(a: Quote, b: Quote): boolean {
  return (
    a.price !== b.price ||
    a.volume !== b.volume ||
    a.status !== b.status ||
    a.high !== b.high ||
    a.low !== b.low ||
    a.changePct !== b.changePct
  );
}
