import { config, marketPlan } from '../config.js';
import { computeInterval } from '../lib/budget.js';
import { log } from '../lib/logger.js';
import type { VendorAdapter } from './provider.js';
import { BinanceAdapter } from './providers/binance.js';
import { SahmkAdapter } from './providers/sahmk.js';
import { SimulatedAdapter } from './providers/simulated.js';
import { TwelveDataAdapter } from './providers/twelvedata.js';
import { sessionMinutes, shouldPoll } from './session.js';
import { QuoteStore } from './store.js';
import type { Candle, Instrument, MarketId, MarketSnapshot, Quote, Range } from './types.js';

/**
 * ============================================================================
 * The engine
 * ============================================================================
 * One place that knows how to keep a market fresh without bankrupting the data
 * plan, and one place that fans the result out to every connected screen.
 *
 * Per market it decides:
 *   - stream if the vendor offers one (Binance), poll otherwise (SAHMK, TD)
 *   - how often to poll, derived from the plan's daily budget and the length of
 *     the trading session — not from a number someone typed in
 *   - when to stop entirely, because the exchange is closed
 *   - when to mark data as CACHED, because the upstream stopped answering
 *
 * Screens never talk to a vendor and never learn a vendor's name.
 */

interface MarketRuntime {
  adapter: VendorAdapter;
  intervalMs: number;
  timer: NodeJS.Timeout | null;
  stream: { stop: () => void } | null;
  consecutiveFailures: number;
  lastPollAt: number;
  lastSuccessAt: number;
  polling: boolean;
}

type QuoteListener = (quotes: Quote[]) => void;
type SnapshotListener = (snapshot: MarketSnapshot) => void;

export class MarketEngine {
  readonly store = new QuoteStore();
  private runtimes = new Map<MarketId, MarketRuntime>();
  private instruments = new Map<string, Instrument>();
  private quoteListeners = new Set<QuoteListener>();
  private snapshotListeners = new Set<SnapshotListener>();
  private started = false;

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;

    await this.store.init();

    const plan = marketPlan();
    log.info('market plan', plan);

    for (const [market, choice] of Object.entries(plan) as Array<[MarketId, string]>) {
      if (choice === 'disabled') {
        log.warn('market disabled — no credentials and simulation is off', { market });
        continue;
      }
      const adapter = this.buildAdapter(market, choice);
      if (!adapter) continue;

      try {
        await adapter.init();
      } catch (err) {
        log.error('adapter init failed', { market, adapter: adapter.id, err: String(err) });
        continue;
      }

      for (const inst of adapter.listInstruments()) this.instruments.set(inst.id, inst);

      const intervalMs = this.planInterval(market, adapter);
      const runtime: MarketRuntime = {
        adapter,
        intervalMs,
        timer: null,
        stream: null,
        consecutiveFailures: 0,
        lastPollAt: 0,
        lastSuccessAt: 0,
        polling: false,
      };
      this.runtimes.set(market, runtime);

      // Seed immediately so the first screen to connect sees prices.
      void this.pollOnce(market).then(() => this.schedule(market));

      if (adapter.stream) {
        runtime.stream = adapter.stream((quotes) => this.ingest(quotes));
        log.info('streaming market', { market, adapter: adapter.id });
      }
    }
  }

  async stop(): Promise<void> {
    for (const rt of this.runtimes.values()) {
      if (rt.timer) clearTimeout(rt.timer);
      rt.stream?.stop();
      rt.adapter.stop?.();
    }
    this.runtimes.clear();
    this.store.stop();
    this.started = false;
  }

  // ------------------------------------------------------------------ reads

  markets(): MarketId[] {
    return [...this.runtimes.keys()];
  }

  universe(market?: MarketId): Instrument[] {
    const all = [...this.instruments.values()];
    return market ? all.filter((i) => i.market === market) : all;
  }

  instrument(id: string): Instrument | undefined {
    return this.instruments.get(id);
  }

  quotes(ids: string[]): Quote[] {
    return this.store.many(ids);
  }

  snapshot(market: MarketId): MarketSnapshot | undefined {
    return this.store.snapshot(market);
  }

  async candles(id: string, range: Range): Promise<Candle[]> {
    const inst = this.instruments.get(id);
    if (!inst) return [];
    const rt = this.runtimes.get(inst.market);
    if (!rt) return [];
    return rt.adapter.getCandles(id, range);
  }

  /** Everything the /health and /status endpoints need to be useful. */
  status() {
    return {
      markets: [...this.runtimes.entries()].map(([market, rt]) => ({
        market,
        adapter: rt.adapter.id,
        intervalSeconds: Math.round(rt.intervalMs / 1000),
        instruments: rt.adapter.listInstruments().length,
        quotesCached: this.store.forMarket(market).length,
        streaming: !!rt.stream,
        polling: shouldPoll(market),
        consecutiveFailures: rt.consecutiveFailures,
        lastPollAt: rt.lastPollAt ? new Date(rt.lastPollAt).toISOString() : null,
        lastSuccessAt: rt.lastSuccessAt ? new Date(rt.lastSuccessAt).toISOString() : null,
        dataStatus: this.store.snapshot(market)?.status ?? 'offline',
        budget: hasStats(rt.adapter) ? rt.adapter.stats() : null,
      })),
      totalQuotes: this.store.size(),
    };
  }

  // --------------------------------------------------------- subscriptions

  onQuotes(fn: QuoteListener): () => void {
    this.quoteListeners.add(fn);
    return () => this.quoteListeners.delete(fn);
  }

  onSnapshot(fn: SnapshotListener): () => void {
    this.snapshotListeners.add(fn);
    return () => this.snapshotListeners.delete(fn);
  }

  // ------------------------------------------------------------- internals

  private buildAdapter(market: MarketId, choice: string): VendorAdapter | null {
    switch (choice) {
      case 'sahmk': return new SahmkAdapter();
      case 'twelvedata': return new TwelveDataAdapter();
      case 'binance': return new BinanceAdapter();
      case 'simulated': return new SimulatedAdapter(market);
      default:
        log.error('unknown adapter choice', { market, choice });
        return null;
    }
  }

  /**
   * Turn a daily request allowance into a poll interval.
   * A streaming market still polls, but only slowly — that poll is a safety
   * net that repairs anything the stream missed, not the primary source.
   */
  private planInterval(market: MarketId, adapter: VendorAdapter): number {
    if (adapter.stream) return 5 * 60_000;

    if (adapter.id === 'simulated') return 2_000;

    const dailyBudget = market === 'saudi' ? config.SAHMK_DAILY_BUDGET : config.TWELVEDATA_DAILY_BUDGET;

    return computeInterval({
      label: `${market}:${adapter.id}`,
      dailyBudget,
      requestsPerPoll: Math.max(1, adapter.requestsPerPoll()),
      sessionMinutes: sessionMinutes(market),
      // Hold back a third for Focus Mode charts, search and reconnecting screens.
      reserve: 0.3,
      minIntervalMs: 10_000,
      maxIntervalMs: 30 * 60_000,
    });
  }

  private schedule(market: MarketId) {
    const rt = this.runtimes.get(market);
    if (!rt) return;
    if (rt.timer) clearTimeout(rt.timer);

    // When the market is shut, check back every few minutes to catch the open
    // rather than burning the budget on a frozen tape.
    const closedIdle = 5 * 60_000;
    const delay = shouldPoll(market) ? rt.intervalMs : closedIdle;

    rt.timer = setTimeout(() => {
      void this.pollOnce(market).finally(() => this.schedule(market));
    }, delay);
  }

  private async pollOnce(market: MarketId): Promise<void> {
    const rt = this.runtimes.get(market);
    if (!rt || rt.polling) return;

    // Outside the session there is nothing new to fetch — but do one poll after
    // the close so the wall shows final prices rather than the last tick.
    const inSession = shouldPoll(market);
    const staleAfterClose = Date.now() - rt.lastSuccessAt > 10 * 60_000;
    if (!inSession && rt.lastSuccessAt && !staleAfterClose) return;

    rt.polling = true;
    rt.lastPollAt = Date.now();

    try {
      const { quotes, snapshot } = await rt.adapter.poll();

      if (quotes.length) this.ingest(quotes);
      if (snapshot) {
        this.store.setSnapshot(snapshot);
        for (const fn of this.snapshotListeners) fn(snapshot);
      }

      if (quotes.length || snapshot) {
        rt.lastSuccessAt = Date.now();
        rt.consecutiveFailures = 0;
      }
    } catch (err) {
      rt.consecutiveFailures++;
      log.warn('poll failed', {
        market,
        adapter: rt.adapter.id,
        failures: rt.consecutiveFailures,
        err: String(err),
      });

      // Three strikes and we stop claiming the data is current. The prices stay
      // on screen — a trader would rather see the last known tape than a blank
      // wall — but they are relabelled CACHED and the TV badge changes with it.
      if (rt.consecutiveFailures === 3) {
        const degraded = this.store.degrade(market);
        if (degraded.length) {
          for (const fn of this.quoteListeners) fn(degraded);
        }
        const snap = this.store.snapshot(market);
        if (snap) for (const fn of this.snapshotListeners) fn(snap);
        log.warn('market degraded to cached', { market, quotes: degraded.length });
      }
    } finally {
      rt.polling = false;
    }
  }

  private ingest(quotes: Quote[]) {
    const changed = this.store.upsert(quotes);
    if (!changed.length) return;
    for (const fn of this.quoteListeners) fn(changed);
  }
}

function hasStats(a: VendorAdapter): a is VendorAdapter & { stats: () => unknown } {
  return typeof (a as { stats?: unknown }).stats === 'function';
}
