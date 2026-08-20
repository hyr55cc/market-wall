import { log } from './logger.js';

/**
 * ============================================================================
 * Request budget → poll interval
 * ============================================================================
 * Market data plans are sold by requests per day, and the fastest way to break
 * a deployment is to pick a refresh interval by feel and blow through the quota
 * by 11am. So we do the arithmetic instead:
 *
 *   interval = (session minutes × requests per poll) / daily budget
 *
 * with a safety margin held back for ad-hoc traffic (a TV opening Focus Mode
 * asks for candles, someone searches, a screen reconnects).
 *
 * The tracker also counts what actually goes out and refuses to spend past the
 * budget — belt and braces, because a vendor cutting you off mid-session is a
 * far worse outcome than a slightly stale price.
 */

export interface BudgetOptions {
  /** Requests the plan allows per day. */
  dailyBudget: number;
  /** Requests consumed by one refresh cycle. */
  requestsPerPoll: number;
  /** Minutes the market is open (crypto = 1440). */
  sessionMinutes: number;
  /** Fraction of the budget reserved for on-demand traffic. 0.3 = keep 30 %. */
  reserve?: number;
  /** Never poll faster than this, whatever the arithmetic says. */
  minIntervalMs?: number;
  /** Never poll slower than this. */
  maxIntervalMs?: number;
  label: string;
}

export function computeInterval(o: BudgetOptions): number {
  const reserve = o.reserve ?? 0.3;
  const minInterval = o.minIntervalMs ?? 5_000;
  const maxInterval = o.maxIntervalMs ?? 30 * 60_000;

  const usable = Math.max(1, Math.floor(o.dailyBudget * (1 - reserve)));
  const pollsAffordable = Math.max(1, Math.floor(usable / Math.max(1, o.requestsPerPoll)));
  const intervalMs = Math.ceil((o.sessionMinutes * 60_000) / pollsAffordable);

  const chosen = Math.min(maxInterval, Math.max(minInterval, intervalMs));

  log.info('poll interval computed', {
    label: o.label,
    dailyBudget: o.dailyBudget,
    requestsPerPoll: o.requestsPerPoll,
    sessionMinutes: o.sessionMinutes,
    pollsAffordable,
    intervalSeconds: Math.round(chosen / 1000),
  });

  return chosen;
}

/**
 * Counts spend against a daily allowance that resets at the exchange's
 * midnight, which is when vendors reset theirs.
 */
export class BudgetTracker {
  private spent = 0;
  private windowStart = Date.now();
  private resetAt: number;

  constructor(
    private readonly label: string,
    private readonly dailyBudget: number,
    /** IANA timezone whose midnight resets the counter. */
    private readonly timezone = 'Asia/Riyadh',
  ) {
    this.resetAt = nextMidnight(this.timezone);
  }

  /** Ask permission to spend `n` requests. Returns false when the budget is out. */
  trySpend(n = 1): boolean {
    this.rollIfNeeded();
    if (this.spent + n > this.dailyBudget) {
      log.warn('request budget exhausted', {
        label: this.label,
        spent: this.spent,
        dailyBudget: this.dailyBudget,
        resetsAt: new Date(this.resetAt).toISOString(),
      });
      return false;
    }
    this.spent += n;
    return true;
  }

  /** Trust the vendor's own counter when it sends one. */
  syncFromHeaders(headers: Headers) {
    const remaining = Number(headers.get('x-ratelimit-remaining'));
    const limit = Number(headers.get('x-ratelimit-limit'));
    if (Number.isFinite(remaining) && Number.isFinite(limit) && limit > 0) {
      this.spent = Math.max(this.spent, limit - remaining);
    }
    const reset = Number(headers.get('x-ratelimit-reset'));
    if (Number.isFinite(reset) && reset > 0) {
      this.resetAt = reset < 1e12 ? reset * 1000 : reset;
    }
  }

  stats() {
    this.rollIfNeeded();
    return {
      label: this.label,
      spent: this.spent,
      dailyBudget: this.dailyBudget,
      remaining: Math.max(0, this.dailyBudget - this.spent),
      resetsAt: new Date(this.resetAt).toISOString(),
      windowStartedAt: new Date(this.windowStart).toISOString(),
    };
  }

  private rollIfNeeded() {
    if (Date.now() < this.resetAt) return;
    this.spent = 0;
    this.windowStart = Date.now();
    this.resetAt = nextMidnight(this.timezone);
  }
}

function nextMidnight(timezone: string): number {
  const now = new Date();
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const parts = fmt.formatToParts(now);
    const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
    const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
    const msIntoDay = (h * 60 + m) * 60_000;
    return now.getTime() + (86_400_000 - msIntoDay);
  } catch {
    return now.getTime() + 86_400_000;
  }
}

/**
 * A token bucket for plans that also cap requests per minute (Twelve Data
 * Basic allows 8/min). Prevents a burst at startup from tripping the limit.
 */
export class MinuteLimiter {
  private tokens: number;
  private last = Date.now();

  constructor(private readonly perMinute: number) {
    this.tokens = perMinute;
  }

  async take(n = 1): Promise<void> {
    for (;;) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      const deficit = n - this.tokens;
      const waitMs = Math.ceil((deficit / this.perMinute) * 60_000);
      await new Promise((r) => setTimeout(r, Math.min(waitMs, 60_000)));
    }
  }

  private refill() {
    const now = Date.now();
    const elapsed = now - this.last;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.perMinute, this.tokens + (elapsed / 60_000) * this.perMinute);
    this.last = now;
  }
}
