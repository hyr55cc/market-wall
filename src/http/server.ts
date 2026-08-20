import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import { config, corsOrigins, marketPlan } from '../config.js';
import { BUILD } from '../version.js';
import { log } from '../lib/logger.js';
import { dbReady } from '../db/index.js';
import type { MarketEngine } from '../market/engine.js';
import type { Gateway } from '../ws/gateway.js';
import { registerMarketRoutes } from './routes/market.js';
import { registerPairingRoutes } from './routes/pairing.js';
import { registerWatchlistRoutes } from './routes/watchlists.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Set once the WebSocket gateway is attached, so routes can relay frames. */
    marketWallGateway?: Gateway;
  }
}

export async function buildServer(engine: MarketEngine): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,          // we emit our own structured lines
    trustProxy: true,       // Railway, Render and friends sit behind a proxy
    bodyLimit: 256 * 1024,
  });

  // Fastify refuses new decorators once the instance has started, so the slot
  // is reserved here and filled in once the WebSocket gateway exists.
  app.decorate('marketWallGateway', undefined);

  await app.register(cors, {
    origin: corsOrigins(),
    credentials: false,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });

  app.addHook('onResponse', async (req, reply) => {
    // Health checks fire every few seconds; logging them buries everything else.
    if (req.url.startsWith('/health')) return;
    log.debug('request', {
      method: req.method,
      url: req.url,
      status: reply.statusCode,
      ms: Math.round(reply.elapsedTime),
    });
  });

  app.setErrorHandler((error, req, reply) => {
    const err = error as Error & { statusCode?: number };
    log.error('request failed', { url: req.url, err: err.message });
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    // Never leak an internal message to a client in production — a stack trace
    // in a JSON body is a free map of the service.
    reply.code(status).send({
      error: config.NODE_ENV === 'production' ? 'internal error' : err.message,
    });
  });

  /**
   * Liveness. Deliberately cheap and deliberately honest: it reports degraded
   * rather than failing, because a market wall with a stale Saudi feed and a
   * live crypto feed is still doing most of its job, and a platform that
   * restarts the container would make that worse, not better.
   */
  app.get('/health', async () => {
    const status = engine.status();
    const anyLive = status.markets.some((m) => m.dataStatus === 'live' || m.dataStatus === 'delayed');
    return {
      ok: true,
      build: BUILD,
      state: anyLive ? 'healthy' : status.markets.length ? 'degraded' : 'starting',
      uptimeSeconds: Math.round(process.uptime()),
      markets: status.markets.map((m) => ({ market: m.market, dataStatus: m.dataStatus })),
    };
  });

  /** Everything you need to debug a deployment without shelling into it. */
  app.get('/v1/status', async () => ({
    build: BUILD,
    plan: marketPlan(),
    database: dbReady(),
    redis: !!config.REDIS_URL,
    engine: engine.status(),
    sockets: app.marketWallGateway?.stats() ?? { connections: 0, devices: 0, subscriptions: 0 },
    version: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.GIT_SHA ?? 'dev',
  }));

  registerMarketRoutes(app, engine);
  registerPairingRoutes(app);
  registerWatchlistRoutes(app);

  return app;
}
