import { config } from '../../config.js';
import { BudgetTracker } from '../../lib/budget.js';
import { fetchJson, qs, UpstreamError } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { enrich, referenceUniverse } from '../reference/index.js';
import { num, pctChange, type VendorAdapter } from '../provider.js';
import { sessionFor } from '../session.js';
import { EMPTY_BREADTH, type Candle, type DataStatus, type Instrument, type MarketSnapshot, type Quote, type Range } from '../types.js';

/**
 * ============================================================================
 * SAHMK — Saudi Exchange (TASI / NOMU)
 * ============================================================================
 * Docs: https://www.sahmk.sa/en/developers/docs
 * Auth: `X-API-Key` header. Rate limit reported in X-RateLimit-* headers,
 * resetting at Asia/Riyadh midnight.
 *
 * Plan-aware by design, because the endpoints you may call change with the tier:
 *
 *   Free      15-min delayed · 100 req/day  · summary + gainers/losers/volume/value
 *   Starter   15-min delayed · 5 000/day    · adds bulk /quotes/ and /historical/
 *   Pro       real-time      · 50 000/day   · adds WebSocket
 *
 * On the Free plan there is no bulk quote endpoint, so we assemble the tape
 * from the four "top" lists — which between them cover the names anyone
 * actually watches — plus the market summary. That is five requests per cycle
 * and it keeps a real Saudi wall on screen for nothing.
 *
 * ── The delayed ceiling ─────────────────────────────────────────────────────
 * `SAHMK_DATA_MODE=delayed` is a hard cap enforced here: even if the upstream
 * says `is_delayed: false`, we publish `status: 'delayed'`. A licence for
 * delayed data that gets displayed as live is a contract breach, and the whole
 * point of this layer is that the TV cannot make that mistake (spec §57).
 */

interface SahmkQuoteRow {
  symbol?: string | number;
  name?: string;
  name_en?: string;
  name_ar?: string;
  price?: number | string;
  last_price?: number | string;
  change?: number | string;
  change_percent?: number | string;
  percent_change?: number | string;
  open?: number | string;
  high?: number | string;
  low?: number | string;
  previous_close?: number | string;
  prev_close?: number | string;
  volume?: number | string;
  value?: number | string;
  updated_at?: string | number;
  is_delayed?: boolean;
  sector_name_en?: string;
  sector_name?: string;
}

interface SahmkSummary {
  index?: string;
  is_delayed?: boolean;
  timestamp?: string | number;
  index_value?: number | string;
  index_change?: number | string;
  index_change_percent?: number | string;
  total_volume?: number | string;
  advancing?: number | string;
  declining?: number | string;
  unchanged?: number | string;
}

export class SahmkAdapter implements VendorAdapter {
  readonly market = 'saudi' as const;
  readonly id = 'sahmk';

  private instruments: Instrument[] = [];
  private budget: BudgetTracker;
  private universeLoadedAt = 0;
  /** Symbols we ask for by name once bulk quotes are available. */
  private tracked: string[] = [];

  constructor() {
    this.budget = new BudgetTracker('sahmk', config.SAHMK_DAILY_BUDGET, 'Asia/Riyadh');
  }

  // ------------------------------------------------------------------ init

  async init(): Promise<void> {
    // Start from local reference data so the service is useful within
    // milliseconds, then refine from the vendor's own directory.
    this.instruments = referenceUniverse('saudi');
    this.tracked = this.instruments.map((i) => i.symbol);
    await this.loadUniverse().catch((err) => {
      log.warn('sahmk: company directory unavailable, using reference universe', { err: String(err) });
    });
  }

  listInstruments(): Instrument[] {
    return this.instruments;
  }

  requestsPerPoll(): number {
    if (config.SAHMK_BULK_QUOTES) {
      // /quotes/ takes up to 50 symbols per call, plus the market summary.
      return Math.ceil(Math.min(this.tracked.length, 200) / 50) + 1;
    }
    // summary + gainers + losers + volume + value
    return 5;
  }

  // ------------------------------------------------------------------ poll

  async poll(): Promise<{ quotes: Quote[]; snapshot?: MarketSnapshot }> {
    const cost = this.requestsPerPoll();
    if (!this.budget.trySpend(cost)) {
      return { quotes: [] };
    }

    const [summary, rows] = await Promise.all([
      this.fetchSummary().catch((err) => {
        log.warn('sahmk: summary failed', { err: String(err) });
        return null;
      }),
      (config.SAHMK_BULK_QUOTES ? this.fetchBulkQuotes() : this.fetchTopLists()).catch((err) => {
        log.warn('sahmk: quotes failed', { err: String(err) });
        return [] as SahmkQuoteRow[];
      }),
    ]);

    const status = this.statusFrom(summary?.is_delayed ?? rows[0]?.is_delayed);
    const quotes = rows.map((r) => this.toQuote(r, status)).filter((q): q is Quote => q !== null);

    return {
      quotes,
      snapshot: summary ? this.toSnapshot(summary, status) : undefined,
    };
  }

  // -------------------------------------------------------------- candles

  async getCandles(id: string, range: Range): Promise<Candle[]> {
    const symbol = id.split(':')[1];
    if (!symbol) return [];
    // /historical/ is Starter and above. Asking for it on Free just burns a
    // request and returns 403, so don't.
    if (!config.SAHMK_BULK_QUOTES) {
      log.debug('sahmk: history skipped, plan does not include /historical/', { symbol });
      return [];
    }
    if (!this.budget.trySpend(1)) return [];

    const { interval, from } = historyWindow(range);
    try {
      const { data, headers } = await fetchJson<{ data?: Array<Record<string, unknown>> }>(
        `${config.SAHMK_BASE_URL}/historical/${encodeURIComponent(symbol)}/${qs({
          interval,
          from,
          to: today(),
          limit: 500,
        })}`,
        { headers: this.headers(), source: 'sahmk:historical' },
      );
      this.budget.syncFromHeaders(headers);

      return (data.data ?? []).map((row) => ({
        t: Date.parse(String(row.date ?? row.datetime ?? '')) || 0,
        o: num(row.open, 0),
        h: num(row.high, 0),
        l: num(row.low, 0),
        c: num(row.close, 0),
        v: num(row.volume, 0),
      })).filter((c) => c.t > 0 && c.c > 0);
    } catch (err) {
      log.warn('sahmk: candles failed', { symbol, range, err: String(err) });
      return [];
    }
  }

  stats() {
    return this.budget.stats();
  }

  // ------------------------------------------------------------- internals

  private headers(): Record<string, string> {
    return { 'X-API-Key': config.SAHMK_API_KEY };
  }

  /**
   * The delayed ceiling. `delayed` mode can only ever produce `delayed`.
   * `realtime` mode still defers to the upstream flag — if the vendor says a
   * particular quote is stale, we say so too.
   */
  private statusFrom(isDelayed: boolean | undefined): DataStatus {
    if (config.SAHMK_DATA_MODE === 'delayed') return 'delayed';
    return isDelayed ? 'delayed' : 'live';
  }

  private async loadUniverse(): Promise<void> {
    // The directory is nearly static; refreshing it daily is plenty.
    if (Date.now() - this.universeLoadedAt < 24 * 3600_000 && this.universeLoadedAt) return;
    if (!this.budget.trySpend(2)) return;

    const merged = new Map<string, Instrument>();
    for (let offset = 0; offset < 400; offset += 200) {
      const { data, headers } = await fetchJson<{ results?: Array<Record<string, unknown>>; total?: number }>(
        `${config.SAHMK_BASE_URL}/companies/${qs({ market: 'TASI', limit: 200, offset })}`,
        { headers: this.headers(), source: 'sahmk:companies' },
      );
      this.budget.syncFromHeaders(headers);

      const results = data.results ?? [];
      for (const row of results) {
        const symbol = String(row.symbol ?? '').trim();
        if (!symbol) continue;
        // Skip anything that isn't an ordinary listed share.
        if (row.is_etf === true) continue;
        merged.set(symbol, enrich('saudi', symbol, {
          nameEn: typeof row.name_en === 'string' ? row.name_en : undefined,
          nameAr: typeof row.name_ar === 'string' ? row.name_ar : undefined,
          sector: typeof row.sector_name_en === 'string' ? row.sector_name_en : undefined,
          currency: 'SAR',
        }));
      }
      if (results.length < 200) break;
    }

    if (merged.size) {
      // Keep any reference instrument the directory didn't return, so a
      // vendor hiccup can never shrink the wall.
      for (const ref of referenceUniverse('saudi')) {
        if (!merged.has(ref.symbol)) merged.set(ref.symbol, ref);
      }
      this.instruments = [...merged.values()];
      this.tracked = this.instruments
        .slice()
        .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
        .map((i) => i.symbol);
      this.universeLoadedAt = Date.now();
      log.info('sahmk: universe loaded', { count: this.instruments.length });
    }
  }

  private async fetchSummary(): Promise<SahmkSummary | null> {
    const { data, headers } = await fetchJson<SahmkSummary>(
      `${config.SAHMK_BASE_URL}/market/summary/${qs({ index: 'TASI', data_mode: config.SAHMK_DATA_MODE })}`,
      { headers: this.headers(), source: 'sahmk:summary' },
    );
    this.budget.syncFromHeaders(headers);
    return data;
  }

  /** Starter and above: ask for exactly the symbols we track, 50 at a time. */
  private async fetchBulkQuotes(): Promise<SahmkQuoteRow[]> {
    const symbols = this.tracked.slice(0, 200);
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += 50) chunks.push(symbols.slice(i, i + 50));

    const out: SahmkQuoteRow[] = [];
    for (const chunk of chunks) {
      const { data, headers } = await fetchJson<{ quotes?: SahmkQuoteRow[] }>(
        `${config.SAHMK_BASE_URL}/quotes/${qs({ symbols: chunk.join(','), data_mode: config.SAHMK_DATA_MODE })}`,
        { headers: this.headers(), source: 'sahmk:quotes' },
      );
      this.budget.syncFromHeaders(headers);
      out.push(...(data.quotes ?? []));
    }
    return out;
  }

  /**
   * Free plan: no bulk endpoint, so build the tape from the four ranked lists.
   * Between top gainers, losers, volume and value you get the names that are
   * actually moving — which is exactly what a market wall is for.
   */
  private async fetchTopLists(): Promise<SahmkQuoteRow[]> {
    const limit = 30;
    const mode = config.SAHMK_DATA_MODE;
    const base = config.SAHMK_BASE_URL;
    const h = { headers: this.headers(), source: 'sahmk:top' };

    const [gainers, losers, volume, value] = await Promise.allSettled([
      fetchJson<{ gainers?: SahmkQuoteRow[] }>(`${base}/market/gainers/${qs({ limit, index: 'TASI', data_mode: mode })}`, h),
      fetchJson<{ losers?: SahmkQuoteRow[] }>(`${base}/market/losers/${qs({ limit, index: 'TASI', data_mode: mode })}`, h),
      fetchJson<{ stocks?: SahmkQuoteRow[] }>(`${base}/market/volume/${qs({ limit, index: 'TASI', data_mode: mode })}`, h),
      fetchJson<{ stocks?: SahmkQuoteRow[] }>(`${base}/market/value/${qs({ limit, index: 'TASI', data_mode: mode })}`, h),
    ]);

    const rows: SahmkQuoteRow[] = [];
    const take = (r: PromiseSettledResult<{ data: Record<string, unknown>; headers: Headers }>, key: string) => {
      if (r.status !== 'fulfilled') {
        const err = r.reason;
        if (err instanceof UpstreamError && err.status === 403) {
          log.warn('sahmk: endpoint not included in plan', { key, status: err.status });
        }
        return;
      }
      this.budget.syncFromHeaders(r.value.headers);
      const list = r.value.data[key];
      if (Array.isArray(list)) rows.push(...(list as SahmkQuoteRow[]));
    };

    take(gainers as never, 'gainers');
    take(losers as never, 'losers');
    take(volume as never, 'stocks');
    take(value as never, 'stocks');

    // The lists overlap; last write wins, which is fine — they carry the same
    // price for the same symbol in the same cycle.
    const bySymbol = new Map<string, SahmkQuoteRow>();
    for (const r of rows) {
      const s = String(r.symbol ?? '').trim();
      if (s) bySymbol.set(s, r);
    }
    return [...bySymbol.values()];
  }

  private toQuote(row: SahmkQuoteRow, status: DataStatus): Quote | null {
    const symbol = String(row.symbol ?? '').trim();
    if (!symbol) return null;

    const price = num(row.price ?? row.last_price);
    if (!Number.isFinite(price)) return null;

    const previousClose = num(row.previous_close ?? row.prev_close, NaN);
    const change = num(row.change, Number.isFinite(previousClose) ? price - previousClose : 0);
    const changePct = num(
      row.change_percent ?? row.percent_change,
      pctChange(price, Number.isFinite(previousClose) ? previousClose : price - change),
    );

    const ref = this.instruments.find((i) => i.symbol === symbol);

    return {
      id: `saudi:${symbol}`,
      price,
      change,
      changePct,
      open: num(row.open, price),
      high: num(row.high, price),
      low: num(row.low, price),
      previousClose: Number.isFinite(previousClose) ? previousClose : price - change,
      volume: num(row.volume, 0),
      marketCap: ref?.marketCap,
      spark: [],                        // filled by the engine from poll history
      status,
      ts: toEpoch(row.updated_at) ?? Date.now(),
    };
  }

  private toSnapshot(s: SahmkSummary, status: DataStatus): MarketSnapshot {
    const value = num(s.index_value, 0);
    const change = num(s.index_change, 0);
    const changePct = num(s.index_change_percent, pctChange(value, value - change));
    const ts = toEpoch(s.timestamp) ?? Date.now();

    const index = {
      id: 'saudi:TASI',
      nameEn: 'TASI',
      nameAr: 'تاسي',
      value,
      change,
      changePct,
      status,
      ts,
    };

    return {
      market: 'saudi',
      index,
      indices: [index],
      breadth: {
        ...EMPTY_BREADTH,
        advancing: num(s.advancing, 0),
        declining: num(s.declining, 0),
        unchanged: num(s.unchanged, 0),
        volume: num(s.total_volume, 0),
      },
      session: sessionFor('saudi'),
      status,
      ts,
    };
  }
}

function toEpoch(v: string | number | undefined): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function historyWindow(range: Range): { interval: string; from: string } {
  const day = 86_400_000;
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  switch (range) {
    case '1D': return { interval: '30m', from: iso(now - 3 * day) };
    case '1W': return { interval: '60m', from: iso(now - 10 * day) };
    case '1M': return { interval: '1d', from: iso(now - 45 * day) };
    case '3M': return { interval: '1d', from: iso(now - 100 * day) };
    case '6M': return { interval: '1d', from: iso(now - 200 * day) };
    case '1Y': return { interval: '1d', from: iso(now - 380 * day) };
    case '5Y': return { interval: '1w', from: iso(now - 5 * 370 * day) };
  }
}
