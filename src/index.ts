import { config, envFile, marketPlan } from './config.js';
import { BUILD, BUILD_NOTES } from './version.js';
import { log } from './lib/logger.js';
import { closeDb, initDb } from './db/index.js';
import { buildServer } from './http/server.js';
import { MarketEngine } from './market/engine.js';
import { Gateway } from './ws/gateway.js';

/**
 * Boot order matters:
 *   1. database  — optional; failure downgrades features, never blocks the boot
 *   2. engine    — opens vendor connections and seeds the quote cache
 *   3. http + ws — only starts listening once there is something to serve
 *
 * A screen that connects the instant the process is up should see prices, not
 * an empty wall that fills in thirty seconds later.
 */
async function main() {
  log.info('starting MARKET WALL backend', {
    build: BUILD,
    notes: BUILD_NOTES,
    env: config.NODE_ENV,
    plan: marketPlan(),
  });

  if (envFile.loaded) {
    log.info('.env loaded', { path: envFile.path, variables: envFile.count });
  } else {
    log.info('no .env file — reading configuration from the environment', { lookedFor: envFile.path });
  }

  warnAboutMisconfiguration();

  await initDb();

  const engine = new MarketEngine();
  await engine.start();

  const app = await buildServer(engine);

  // Attach the socket gateway before listening, so the first client to connect
  // cannot arrive during a window where /stream isn't wired up yet.
  await app.ready();
  const gateway = new Gateway(app.server, engine);
  app.marketWallGateway = gateway;

  try {
    await app.listen({ port: config.PORT, host: config.HOST });
  } catch (err) {
    explainListenFailure(err);
    process.exit(1);
  }

  log.info('listening', { port: config.PORT, host: config.HOST });

  const shutdown = async (signal: string) => {
    log.info('shutting down', { signal });
    // Close the front door first so nothing new arrives, then let the engine
    // flush its cache to Redis before the process exits.
    gateway.close();
    await app.close().catch(() => undefined);
    await engine.stop();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    // A vendor timing out must not take the wall down with it.
    log.error('unhandled rejection', { reason: String(reason) });
  });
}

/**
 * Turn Node's terse listen errors into something actionable.
 *
 * `EACCES` on a high port surprises people, because it reads like a file
 * permission problem. On Windows it usually is not: Hyper-V, WSL2 and Docker
 * Desktop reserve whole ranges of TCP ports, and 8080 falls inside one often
 * enough to be the single most common first-run failure on that platform.
 */
function explainListenFailure(err: unknown) {
  const e = err as NodeJS.ErrnoException;
  const port = config.PORT;

  if (e?.code === 'EACCES') {
    log.error(`cannot bind port ${port} — the operating system refused it`, {
      likelyCause:
        'On Windows, Hyper-V / WSL2 / Docker Desktop reserve ranges of ports. On macOS and Linux, ports below 1024 need root.',
      fix: `Pick another port: add a line   PORT=5055   to your .env file, then run npm run dev again.`,
      windowsCheck: 'To see reserved ranges: netsh interface ipv4 show excludedportrange protocol=tcp',
      remember: 'If you change the port, point the TV app at it too: VITE_API_URL=http://localhost:5055',
    });
    return;
  }

  if (e?.code === 'EADDRINUSE') {
    log.error(`port ${port} is already in use`, {
      likelyCause: 'Another copy of this server is probably still running in a different terminal window.',
      fix: `Close the other window, or add a line   PORT=5055   to your .env file.`,
    });
    return;
  }

  log.error('failed to start the HTTP server', { err: e?.message ?? String(err), code: e?.code });
}

/**
 * Say plainly what is missing at boot. Half the support cost of a service like
 * this is someone staring at an empty screen because an env var was never set.
 */
function warnAboutMisconfiguration() {
  const plan = marketPlan();

  // The single most likely first-run failure: no configuration at all. Say
  // exactly what to do rather than starting up serving nothing.
  if (Object.values(plan).every((v) => v === 'disabled')) {
    log.error('no markets are enabled — the wall will be empty', {
      fix: 'Create a .env file next to package.json. To try it with no API keys, put: ALLOW_SIMULATED=true and TOKEN_SECRET=dev',
      example: 'copy .env.example .env   (Windows)   ·   cp .env.example .env   (macOS/Linux)',
    });
  }

  if (plan.saudi === 'disabled') {
    log.warn('Saudi market off: set SAHMK_API_KEY (or ALLOW_SIMULATED=true for a demo)');
  }
  if (plan.us === 'disabled') {
    log.warn('US market off: set TWELVEDATA_API_KEY (or ALLOW_SIMULATED=true for a demo)');
  }
  if (plan.saudi === 'sahmk' && config.SAHMK_DAILY_BUDGET <= 100 && config.SAHMK_BULK_QUOTES) {
    log.warn('SAHMK_BULK_QUOTES is on but the budget looks like the Free plan — bulk quotes need Starter or above');
  }
  if (config.ALLOW_SIMULATED && config.NODE_ENV === 'production') {
    log.warn('ALLOW_SIMULATED is enabled in production — screens may show data badged SIMULATED');
  }
  if (config.SAHMK_DATA_MODE === 'realtime' && !config.SAHMK_WEBSOCKET) {
    log.info('SAHMK realtime mode without WebSocket — polling will still be capped by your plan');
  }
}

main().catch((err) => {
  log.error('fatal', { err: err instanceof Error ? err.stack : String(err) });
  process.exit(1);
});
