import { referenceUniverse } from '../reference/index.js';
import { pctChange, type VendorAdapter } from '../provider.js';
import { sessionFor } from '../session.js';
import { EMPTY_BREADTH, type Candle, type Instrument, type MarketId, type MarketSnapshot, type Quote, type Range } from '../types.js';

/**
 * Deterministic fake market, for demos and for developing against a feed you
 * have not licensed yet. Only reachable when ALLOW_SIMULATED=true.
 *
 * Every quote it produces is stamped `status: 'simulated'`, which the TV renders
 * as a blue SIMULATED badge. There is no configuration that makes it claim to
 * be live — that is the point (spec §57, §58).
 */
export class SimulatedAdapter implements VendorAdapter {
  readonly id = 'simulated';
  private instruments: Instrument[] = [];
  private state = new Map<string, { base: number; price: number; prevClose: number; open: number; high: number; low: number; volume: number; avgVolume: number; vol: number; rand: () => number }>();

  constructor(readonly market: MarketId) {}

  async init(): Promise<void> {
    this.instruments = referenceUniverse(this.market);
    for (const inst of this.instruments) {
      const seed = hash(inst.id);
      const rand = mulberry32(Math.floor(seed * 1e9));
      const capScale = Math.log10((inst.marketCap ?? 1e9) / 1e9 + 1);
      const base =
        this.market === 'saudi' ? 12 + seed * 180 + capScale * 8
        : this.market === 'crypto' ? 0.5 + seed * 400
        : 20 + seed * 420 + capScale * 40;
      const prevClose = round(base, this.market === 'crypto' ? 4 : 2);
      const price = round(prevClose * (1 + (rand() - 0.5) * 0.04), this.market === 'crypto' ? 4 : 2);
      const avgVolume = Math.round((2e5 + rand() * 4e6) * (1 + capScale));
      this.state.set(inst.id, {
        base, price, prevClose,
        open: price,
        high: Math.max(price, prevClose),
        low: Math.min(price, prevClose),
        volume: Math.round(avgVolume * (0.3 + rand() * 1.6)),
        avgVolume,
        vol: 0.0016 + (1 - Math.min(capScale / 3.5, 0.95)) * 0.004,
        rand,
      });
    }
  }

  listInstruments(): Instrument[] {
    return this.instruments;
  }

  requestsPerPoll(): number {
    return 0; // costs nothing; the engine still paces it
  }

  async poll(): Promise<{ quotes: Quote[]; snapshot?: MarketSnapshot }> {
    const session = sessionFor(this.market);
    const frozen = session === 'closed' || session === 'pre';
    const quotes: Quote[] = [];

    for (const inst of this.instruments) {
      const st = this.state.get(inst.id)!;
      if (!frozen) {
        const pull = ((st.base - st.price) / st.base) * 0.02;
        const noise = (st.rand() - 0.5) * st.vol * 2;
        st.price = round(Math.max(0.01, st.price * (1 + pull + noise)), this.market === 'crypto' ? 4 : 2);
        st.high = Math.max(st.high, st.price);
        st.low = Math.min(st.low, st.price);
        st.volume += Math.round(st.avgVolume * 0.002 * (0.5 + st.rand()));
      }
      quotes.push({
        id: inst.id,
        price: st.price,
        change: round(st.price - st.prevClose, 4),
        changePct: pctChange(st.price, st.prevClose),
        open: st.open,
        high: st.high,
        low: st.low,
        previousClose: st.prevClose,
        volume: st.volume,
        avgVolume: st.avgVolume,
        week52High: round(st.base * 1.35, 2),
        week52Low: round(st.base * 0.68, 2),
        marketCap: inst.marketCap,
        spark: [],
        status: 'simulated',
        ts: Date.now(),
      });
    }

    return { quotes, snapshot: this.buildSnapshot(quotes) };
  }

  async getCandles(id: string, range: Range): Promise<Candle[]> {
    const st = this.state.get(id);
    if (!st) return [];
    const points = { '1D': 78, '1W': 70, '1M': 66, '3M': 64, '6M': 78, '1Y': 104, '5Y': 130 }[range];
    const step = { '1D': 3e5, '1W': 36e5, '1M': 864e5, '3M': 12e7, '6M': 2e8, '1Y': 3e8, '5Y': 12e8 }[range];
    const rand = mulberry32(Math.floor(hash(id + range) * 1e9));
    const out: Candle[] = [];
    let c = st.price * (0.8 + rand() * 0.4);
    const now = Date.now();
    for (let i = points - 1; i >= 0; i--) {
      const o = c;
      c = Math.max(0.0001, o * (1 + (rand() - 0.5) * st.vol * 6));
      out.push({
        t: now - i * step,
        o, c,
        h: Math.max(o, c) * (1 + rand() * st.vol * 2),
        l: Math.min(o, c) * (1 - rand() * st.vol * 2),
        v: Math.round(st.avgVolume * (0.4 + rand())),
      });
    }
    const last = out[out.length - 1]?.c ?? 0;
    if (last > 0) {
      const k = st.price / last;
      for (const candle of out) { candle.o *= k; candle.h *= k; candle.l *= k; candle.c *= k; }
      out[out.length - 1].c = st.price;
    }
    return out;
  }

  private buildSnapshot(quotes: Quote[]): MarketSnapshot {
    let advancing = 0, declining = 0, unchanged = 0, volume = 0, capSum = 0, weighted = 0;
    for (const q of quotes) {
      volume += q.volume;
      const cap = q.marketCap ?? 1e9;
      capSum += cap;
      weighted += q.changePct * cap;
      if (q.changePct > 0.02) advancing++;
      else if (q.changePct < -0.02) declining++;
      else unchanged++;
    }
    const changePct = capSum ? weighted / capSum : 0;
    const nameEn = this.market === 'saudi' ? 'TASI (SIMULATED)' : this.market === 'us' ? 'US BASKET (SIMULATED)' : 'CRYPTO (SIMULATED)';
    const base = this.market === 'saudi' ? 11850 : this.market === 'us' ? 5850 : 100;
    const index = {
      id: `${this.market}:SIM`,
      nameEn,
      nameAr: nameEn,
      value: base * (1 + changePct / 100),
      change: (base * changePct) / 100,
      changePct,
      status: 'simulated' as const,
      ts: Date.now(),
    };
    return {
      market: this.market,
      index,
      indices: [index],
      breadth: { ...EMPTY_BREADTH, advancing, declining, unchanged, volume },
      session: sessionFor(this.market),
      status: 'simulated',
      ts: Date.now(),
    };
  }
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

function mulberry32(a: number) {
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function round(n: number, d: number): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}
