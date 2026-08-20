import type { MarketId, SessionState } from './types.js';

/**
 * Trading sessions in the *exchange's* timezone.
 *
 * The engine uses this for two things that matter commercially:
 *  1. it stops polling a closed market, which is where most of the request
 *     budget would otherwise be wasted;
 *  2. it tells the TV honestly whether it is looking at a live tape or a
 *     closing price.
 */

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
const FORMATTERS = new Map<string, Intl.DateTimeFormat>();

function wall(tz: string, fallbackOffsetHours: number, now = new Date()) {
  let f = FORMATTERS.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      });
      FORMATTERS.set(tz, f);
    } catch {
      const shifted = new Date(now.getTime() + fallbackOffsetHours * 3600_000);
      return { weekday: shifted.getUTCDay(), minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes() };
    }
  }
  const parts = f.formatToParts(now);
  const wd = parts.find((p) => p.type === 'weekday')?.value ?? 'Mon';
  const hh = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const mm = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { weekday: DAYS[wd] ?? 1, minutes: hh * 60 + mm };
}

const HM = (h: number, m = 0) => h * 60 + m;

export function sessionFor(market: MarketId, now = new Date()): SessionState {
  if (market === 'crypto') return 'always';

  if (market === 'saudi') {
    // Saudi Exchange: Sun–Thu, pre-open 09:30, continuous 10:00–15:00,
    // closing auction to 15:20 (Asia/Riyadh).
    const { weekday, minutes } = wall('Asia/Riyadh', 3, now);
    if (weekday === 5 || weekday === 6) return 'closed';
    if (minutes >= HM(9, 30) && minutes < HM(10)) return 'pre';
    if (minutes >= HM(10) && minutes < HM(15)) return 'open';
    if (minutes >= HM(15) && minutes < HM(15, 20)) return 'post';
    return 'closed';
  }

  // NYSE / NASDAQ: Mon–Fri, 09:30–16:00 America/New_York.
  const { weekday, minutes } = wall('America/New_York', -5, now);
  if (weekday === 0 || weekday === 6) return 'closed';
  if (minutes >= HM(4) && minutes < HM(9, 30)) return 'pre';
  if (minutes >= HM(9, 30) && minutes < HM(16)) return 'open';
  if (minutes >= HM(16) && minutes < HM(20)) return 'post';
  return 'closed';
}

/** Minutes per day we actually need to poll — the input to budget planning. */
export function sessionMinutes(market: MarketId): number {
  switch (market) {
    case 'saudi': return 5 * 60 + 20;   // 10:00 → 15:20
    case 'us': return 6 * 60 + 30;      // 09:30 → 16:00
    case 'crypto': return 24 * 60;
  }
}

/** True when it is worth spending a request. */
export function shouldPoll(market: MarketId, now = new Date()): boolean {
  const s = sessionFor(market, now);
  return s === 'open' || s === 'pre' || s === 'post' || s === 'always';
}
