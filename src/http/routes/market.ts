import type { FastifyInstance } from 'fastify';
import type { MarketEngine } from '../../market/engine.js';
import type { MarketId, Range } from '../../market/types.js';

const MARKETS: MarketId[] = ['saudi', 'us', 'crypto'];
const RANGES: Range[] = ['1D', '1W', '1M', '3M', '6M', '1Y', '5Y'];

/**
 * The market-data API the TV app already speaks.
 *
 * These four routes are the entire contract in `BackendProvider.ts` on the TV
 * side. Everything is a cache read — no request here ever reaches a vendor,
 * which is why a hundred screens cost the same as one.
 */
export function registerMarketRoutes(app: FastifyInstance, engine: MarketEngine) {
  const parseMarket = (value: string): MarketId | null =>
    (MARKETS as string[]).includes(value) ? (value as MarketId) : null;

  app.get<{ Params: { market: string } }>('/v1/markets/:market/instruments', async (req, reply) => {
    const market = parseMarket(req.params.market);
    if (!market) return reply.code(400).send({ error: 'unknown market' });
    // Instruments change about once a quarter; let the TV hold them for an hour.
    reply.header('cache-control', 'public, max-age=3600');
    return engine.universe(market);
  });

  app.get<{ Params: { market: string }; Querystring: { ids?: string } }>(
    '/v1/markets/:market/quotes',
    async (req, reply) => {
      const market = parseMarket(req.params.market);
      if (!market) return reply.code(400).send({ error: 'unknown market' });

      reply.header('cache-control', 'no-store');

      const raw = (req.query.ids ?? '').trim();
      if (!raw) return engine.store.forMarket(market);

      // Cap the request so one screen can't ask for the world in a loop.
      const ids = raw.split(',').map((s) => s.trim()).filter(Boolean).slice(0, 500);
      return engine.quotes(ids);
    },
  );

  app.get<{ Params: { market: string } }>('/v1/markets/:market/snapshot', async (req, reply) => {
    const market = parseMarket(req.params.market);
    if (!market) return reply.code(400).send({ error: 'unknown market' });

    reply.header('cache-control', 'no-store');
    const snapshot = engine.snapshot(market);
    if (!snapshot) {
      // 503, not 200-with-nulls: the TV must be able to tell "no data yet"
      // from "flat market", and it falls back to its cache on this.
      return reply.code(503).send({ error: 'no snapshot yet', market });
    }
    return snapshot;
  });

  app.get<{ Params: { id: string }; Querystring: { range?: string } }>(
    '/v1/instruments/:id/candles',
    async (req, reply) => {
      const id = decodeURIComponent(req.params.id);
      const range = (req.query.range ?? '1D').toUpperCase() as Range;
      if (!RANGES.includes(range)) return reply.code(400).send({ error: 'unknown range' });
      if (!engine.instrument(id)) return reply.code(404).send({ error: 'unknown instrument' });

      const candles = await engine.candles(id, range);
      // Intraday history goes stale fast; longer ranges barely move.
      reply.header('cache-control', range === '1D' ? 'public, max-age=60' : 'public, max-age=900');
      return candles;
    },
  );

  /** Convenience for the mobile remote: search across every enabled market. */
  app.get<{ Querystring: { q?: string; market?: string; limit?: string } }>(
    '/v1/search',
    async (req, reply) => {
      const q = normalize((req.query.q ?? '').trim());
      if (!q) return [];
      const market = req.query.market ? parseMarket(req.query.market) : null;
      const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 30) || 30));
      reply.header('cache-control', 'public, max-age=300');

      const pool = engine.universe(market ?? undefined);
      const scored: Array<{ score: number; inst: (typeof pool)[number] }> = [];

      for (const inst of pool) {
        const sym = normalize(inst.symbol);
        const en = normalize(inst.nameEn);
        const ar = normalize(inst.nameAr);
        let score = 0;
        if (sym === q) score = 100;
        else if (sym.startsWith(q)) score = 90;
        else if (en.startsWith(q) || ar.startsWith(q)) score = 80;
        else if (en.includes(q) || ar.includes(q)) score = 60;
        else if (sym.includes(q)) score = 50;
        if (score) scored.push({ score: score + Math.log10((inst.marketCap ?? 1) + 1), inst });
      }

      return scored
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ inst }) => ({ ...inst, quote: engine.store.get(inst.id) ?? null }));
    },
  );
}

/** Match the TV's search normalisation so results agree on both sides. */
function normalize(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[ً-ْ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه');
}
