import { config } from '../../config.js';
import { BudgetTracker, MinuteLimiter } from '../../lib/budget.js';
import { fetchJson, qs, UpstreamError } from '../../lib/http.js';
import { log } from '../../lib/logger.js';
import { referenceUniverse } from '../reference/index.js';
import { num, pctChange, type VendorAdapter } from '../provider.js';
import { sessionFor } from '../session.js';
import { EMPTY_BREADTH, type Candle, type DataStatus, type Instrument, type MarketSnapshot, type Quote, type Range } from '../types.js';

/**
 * ============================================================================
 * Twelve Data — US equities (NASDAQ / NYSE)
 * ============================================================================
 * Docs: https://twelvedata.com/docs
 * Auth: `apikey` query parameter.
 *
 * Credits, not requests. `/quote?symbol=A,B,C` is one HTTP call but costs one
 * credit per symbol, and the Basic plan allows 800 credits a day and 8 a
 * minute. So the two things that keep this adapter inside its plan are:
 *
 *   TWELVEDATA_SYMBOL_LIMIT — how many names we track at all
 *   the minute-limiter      — smooths the burst so 8/min is never breached
 *
 * With the defaults (24 symbols, 800 credits/day, 30 % reserve) the engine
 * lands on roughly one refresh every 20 minutes during the US session. Raise
 * the plan and both numbers move together without a code change.
 *
 * Indices: the free plan does not carry S&P/NASDAQ index values, so the
 * snapshot's index is computed from the tracked constituents, cap-weighted,
 * and labelled as a basket rather than passed off as the official index.
 */

interface TdQuote {
  symbol?: string;
  name?: string;
  exchange?: string;
  currency?: string;
  datetime?: string;
  timestamp?: number;
  open?: string | number;
  high?: string | number;
  low?: string | number;
  close?: string | number;
  volume?: string | number;
  previous_close?: string | number;
  change?: string | number;
  percent_change?: string | number;
  average_volume?: string | number;
  fifty_two_week?: { low?: string | number; high?: string | number };
  is_market_open?: boolean;
  status?: string;
  code?: number;
  message?: string;
}

export class TwelveDataAdapter implements VendorAdapter {
  readonly market = 'us' as const;
  readonly id = 'twelvedata';

  private instruments: Instrument[] = [];
  private tracked: Instrument[] = [];
  private budget: BudgetTracker;
  private minute: MinuteLimiter;
  /** null = not yet known, false = plan refused a multi-symbol request. */
  private batchSupported: boolean | null = null;
  /** Last upstream complaint, surfaced at /v1/status so nobody has to grep logs. */
  private lastError: string | null = null;

  constructor() {
    this.budget = new BudgetTracker('twelvedata', config.TWELVEDATA_DAILY_BUDGET, 'America/New_York');
    this.minute = new MinuteLimiter(config.TWELVEDATA_PER_MINUTE);
  }

  async init(): Promise<void> {
    // The US universe is reference data — Twelve Data charges per symbol for
    // quotes, not for knowing that Apple exists.
    this.instruments = referenceUniverse('us');
    this.tracked = [...this.instruments]
      .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
      .slice(0, config.TWELVEDATA_SYMBOL_LIMIT);
    log.info('twelvedata: tracking symbols', {
      tracked: this.tracked.length,
      universe: this.instruments.length,
    });
  }

  listInstruments(): Instrument[] {
    // Only advertise what we can actually price. Listing 80 names and quoting
    // 24 of them would leave two thirds of the wall permanently blank.
    return this.tracked;
  }

  requestsPerPoll(): number {
    return this.tracked.length; // one credit per symbol
  }

  async poll(): Promise<{ quotes: Quote[]; snapshot?: MarketSnapshot }> {
    if (!this.tracked.length) return { quotes: [] };

    const symbols = this.tracked.map((i) => i.symbol);

    /**
     * Chunk by the PER-MINUTE credit allowance, not by what fits in a URL.
     *
     * `/quote?symbol=A,B,C` is one HTTP request but costs one credit per
     * symbol. On the Basic plan that ceiling is 8 credits a minute, so asking
     * for 24 symbols in a single call breaches the limit the instant it is
     * sent — every time, forever, no matter how long the poll interval is.
     * Splitting into runs of 8 and letting the token bucket space them out is
     * the only way a 24-symbol wall can work on that plan.
     */
    const chunkSize = Math.max(1, Math.min(config.TWELVEDATA_PER_MINUTE, 120));
    const chunks: string[][] = [];
    for (let i = 0; i < symbols.length; i += chunkSize) {
      chunks.push(symbols.slice(i, i + chunkSize));
    }

    const rows: TdQuote[] = [];
    const failures: string[] = [];

    for (const chunk of chunks) {
      // Comma-separated batch is a paid-plan feature on some accounts. When it
      // is refused we fall back to one request per symbol — same credit cost,
      // just more HTTP calls — and remember the answer so we only pay for the
      // discovery once per process.
      const useBatch = this.batchSupported !== false && chunk.length > 1;
      const requests = useBatch ? [chunk] : chunk.map((s) => [s]);

      for (const group of requests) {
        if (!this.budget.trySpend(group.length)) break;
        await this.minute.take(group.length);

        try {
          const { data } = await fetchJson<Record<string, TdQuote> | TdQuote>(
            `${config.TWELVEDATA_BASE_URL}/quote${qs({
              symbol: group.join(','),
              apikey: config.TWELVEDATA_API_KEY,
            })}`,
            { source: 'twelvedata:quote' },
          );

          const result = normaliseBatch(data);

          if (result.error) {
            this.lastError = result.error;
            failures.push(result.error);
            // An error on a multi-symbol request, but not on a single one, is
            // the signature of a plan without batch support.
            if (useBatch) {
              log.warn('twelvedata: batch rejected, falling back to one request per symbol', {
                message: result.error,
              });
              this.batchSupported = false;
              break; // re-enter the outer loop, which will now use singles
            }
            continue;
          }

          // Only a batch that actually returned rows proves batch works.
          // Setting this on a merely error-free response is how a broken
          // response gets mistaken for a working one.
          if (useBatch && result.rows.length) this.batchSupported = true;
          rows.push(...result.rows);
        } catch (err) {
          // Log the status and body — "request failed" tells you nothing, while
          // "401 invalid api key" or "429 credits exceeded" tells you everything.
          const e = err as UpstreamError;
          const detail = `${e.status ?? '?'} ${e.body?.slice(0, 200) ?? String(err)}`;
          this.lastError = detail;
          failures.push(detail);
          log.warn('twelvedata: request failed', {
            symbols: group.length,
            status: e.status,
            body: e.body?.slice(0, 300),
          });
        }
      }

      // Batch was just disproved — redo this chunk as single-symbol requests.
      if (useBatch && this.batchSupported === false) {
        for (const symbol of chunk) {
          if (!this.budget.trySpend(1)) break;
          await this.minute.take(1);
          try {
            const { data } = await fetchJson<Record<string, TdQuote> | TdQuote>(
              `${config.TWELVEDATA_BASE_URL}/quote${qs({
                symbol,
                apikey: config.TWELVEDATA_API_KEY,
              })}`,
              { source: 'twelvedata:quote' },
            );
            const result = normaliseBatch(data);
            if (result.error) {
              this.lastError = result.error;
              failures.push(result.error);
              continue;
            }
            rows.push(...result.rows);
          } catch (err) {
            const e = err as UpstreamError;
            this.lastError = `${e.status ?? '?'} ${e.body?.slice(0, 200) ?? String(err)}`;
            failures.push(this.lastError);
          }
        }
      }
    }

    // Nothing at all came back: throw so the engine counts a real failure and
    // the status turns OFFLINE. Swallowing this is what made the market look
    // healthy while showing an empty wall.
    if (!rows.length) {
      if (failures.length) {
        throw new Error(`twelvedata: every request failed — first: ${failures[0]}`);
      }
      return { quotes: [] };
    }

    if (failures.length) {
      log.warn('twelvedata: partial refresh', { ok: rows.length, failed: failures.length });
    } else {
      this.lastError = null;
    }

    const status: DataStatus = config.TWELVEDATA_DATA_MODE === 'delayed' ? 'delayed' : 'live';
    const quotes = rows.map((r) => this.toQuote(r, status)).filter((q): q is Quote => q !== null);

    // Rows arrived but none of them parsed into a usable price. Publishing a
    // snapshot here would label the market LIVE while showing nothing — throw
    // instead, so the status turns OFFLINE and says why.
    if (!quotes.length) {
      const sample = JSON.stringify(rows[0] ?? {}).slice(0, 300);
      this.lastError = `${rows.length} rows returned but none parsed as quotes — sample: ${sample}`;
      throw new Error(this.lastError);
    }

    return { quotes, snapshot: this.toSnapshot(quotes, status) };
  }

  async getCandles(id: string, range: Range): Promise<Candle[]> {
    const symbol = id.split(':')[1];
    if (!symbol) return [];
    if (!this.budget.trySpend(1)) return [];
    await this.minute.take(1);

    const { interval, outputsize } = seriesParams(range);
    try {
      const { data } = await fetchJson<{ values?: Array<Record<string, string>>; status?: string; message?: string }>(
        `${config.TWELVEDATA_BASE_URL}/time_series${qs({
          symbol,
          interval,
          outputsize,
          order: 'ASC',
          apikey: config.TWELVEDATA_API_KEY,
        })}`,
        { source: 'twelvedata:time_series' },
      );
      if (data.status === 'error') {
        log.warn('twelvedata: time_series error', { symbol, message: data.message });
        return [];
      }
      return (data.values ?? [])
        .map((v) => ({
          t: Date.parse(v.datetime?.includes(' ') ? v.datetime.replace(' ', 'T') + 'Z' : `${v.datetime}T00:00:00Z`) || 0,
          o: num(v.open, 0),
          h: num(v.high, 0),
          l: num(v.low, 0),
          c: num(v.close, 0),
          v: num(v.volume, 0),
        }))
        .filter((c) => c.t > 0 && c.c > 0);
    } catch (err) {
      log.warn('twelvedata: candles failed', { symbol, range, err: String(err) });
      return [];
    }
  }

  stats() {
    return {
      ...this.budget.stats(),
      batchSupported: this.batchSupported,
      lastError: this.lastError,
    };
  }

  // ------------------------------------------------------------- internals

  private toQuote(row: TdQuote, status: DataStatus): Quote | null {
    const symbol = String(row.symbol ?? '').trim();
    if (!symbol) return null;
    const price = num(row.close);
    if (!Number.isFinite(price)) return null;

    const previousClose = num(row.previous_close, price);
    const change = num(row.change, price - previousClose);
    const ref = this.instruments.find((i) => i.symbol === symbol);

    return {
      id: `us:${symbol}`,
      price,
      change,
      changePct: num(row.percent_change, pctChange(price, previousClose)),
      open: num(row.open, price),
      high: num(row.high, price),
      low: num(row.low, price),
      previousClose,
      volume: num(row.volume, 0),
      avgVolume: num(row.average_volume, NaN) || undefined,
      week52High: num(row.fifty_two_week?.high, NaN) || undefined,
      week52Low: num(row.fifty_two_week?.low, NaN) || undefined,
      marketCap: ref?.marketCap,
      spark: [],
      status,
      ts: row.timestamp ? row.timestamp * 1000 : Date.now(),
    };
  }

  /**
   * A cap-weighted basket of the names we track. This is NOT the S&P 500 and
   * is not labelled as such — index values are a separately licensed product
   * and inventing one would be exactly the kind of dishonesty this layer exists
   * to prevent.
   */
  private toSnapshot(quotes: Quote[], status: DataStatus): MarketSnapshot {
    let capSum = 0;
    let weighted = 0;
    let advancing = 0;
    let declining = 0;
    let unchanged = 0;
    let volume = 0;
    let upVolume = 0;
    let downVolume = 0;

    for (const q of quotes) {
      const cap = q.marketCap ?? 1e9;
      capSum += cap;
      weighted += q.changePct * cap;
      volume += q.volume;
      if (q.changePct > 0.02) { advancing++; upVolume += q.volume; }
      else if (q.changePct < -0.02) { declining++; downVolume += q.volume; }
      else unchanged++;
    }

    const changePct = capSum ? weighted / capSum : 0;
    const index = {
      id: 'us:BASKET',
      nameEn: 'US LARGE CAP',
      nameAr: 'الشركات الكبرى الأمريكية',
      value: capSum / 1e9,
      change: 0,
      changePct,
      status,
      ts: Date.now(),
    };

    return {
      market: 'us',
      index,
      indices: [index],
      breadth: { ...EMPTY_BREADTH, advancing, declining, unchanged, volume, upVolume, downVolume },
      session: sessionFor('us'),
      status,
      ts: Date.now(),
    };
  }
}

/**
 * `/quote` returns a bare object for one symbol and a symbol-keyed map for many.
 *
 * It also reports failure with HTTP 200 and an error envelope in the body,
 * which parses as "zero symbols" unless you look for it — the difference
 * between a market that is quietly empty and one that tells you why.
 */
function normaliseBatch(data: Record<string, TdQuote> | TdQuote): { rows: TdQuote[]; error?: string } {
  if (!data || typeof data !== 'object') return { rows: [], error: 'empty response' };

  const envelope = data as unknown as { status?: string; code?: number; message?: string };
  if (envelope?.status === 'error') {
    const error = `${envelope.code ?? ''} ${envelope.message ?? 'unknown error'}`.trim();
    log.warn('twelvedata: error envelope', { code: envelope.code, message: envelope.message });
    return { rows: [], error };
  }

  const maybe = data as TdQuote;
  if (typeof maybe.symbol === 'string' && (maybe.close !== undefined || maybe.open !== undefined)) {
    return { rows: [maybe] };
  }

  const rows: TdQuote[] = [];
  const symbolErrors: string[] = [];

  // Some responses wrap the list: { data: [ {...}, {...} ], status: "ok" }.
  const wrapped = (data as unknown as { data?: unknown }).data;
  const entries: Array<[string, TdQuote]> = Array.isArray(wrapped)
    ? (wrapped as TdQuote[]).map((v, i) => [v?.symbol ?? String(i), v])
    : Object.entries(data as Record<string, TdQuote>);

  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;

    if (value.status === 'error') {
      log.warn('twelvedata: symbol error', { symbol: key, message: value.message, code: value.code });
      symbolErrors.push(`${key}: ${value.code ?? ''} ${value.message ?? 'error'}`.trim());
      continue;
    }

    // It must actually look like a quote. Without this check any stray object
    // in the payload counts as a row, and the market reports itself healthy
    // while every card on the wall shows a dash.
    if (value.close === undefined && value.open === undefined && value.previous_close === undefined) {
      continue;
    }

    rows.push({ ...value, symbol: value.symbol ?? key });
  }

  if (rows.length) return { rows };

  /**
   * Zero usable rows and no envelope error. Two things can cause this: every
   * symbol carried its own error, or the payload has a shape this parser does
   * not recognise. Both were previously swallowed, leaving an empty market with
   * no explanation anywhere — so return the reason, including a short preview
   * of what actually arrived. A parser that cannot read a response should at
   * least be able to show it to you.
   */
  if (symbolErrors.length) {
    return { rows: [], error: `all symbols failed — ${symbolErrors[0]}` };
  }

  let preview: string;
  try {
    preview = JSON.stringify(data).slice(0, 400);
  } catch {
    preview = String(data).slice(0, 400);
  }
  return { rows: [], error: `unrecognised response shape: ${preview}` };
}

function seriesParams(range: Range): { interval: string; outputsize: number } {
  switch (range) {
    case '1D': return { interval: '5min', outputsize: 78 };
    case '1W': return { interval: '1h', outputsize: 40 };
    case '1M': return { interval: '1day', outputsize: 22 };
    case '3M': return { interval: '1day', outputsize: 66 };
    case '6M': return { interval: '1day', outputsize: 130 };
    case '1Y': return { interval: '1day', outputsize: 252 };
    case '5Y': return { interval: '1week', outputsize: 260 };
  }
}
