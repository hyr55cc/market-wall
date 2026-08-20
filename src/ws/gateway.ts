import type { Server as HttpServer, IncomingMessage } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { log } from '../lib/logger.js';
import { verifyToken } from '../auth/tokens.js';
import type { MarketEngine } from '../market/engine.js';
import type { ClientFrame, MarketId, MarketSnapshot, Quote, ServerFrame } from '../market/types.js';

/**
 * ============================================================================
 * WebSocket gateway (spec §38)
 * ============================================================================
 *
 *   vendor ──► engine ──► gateway ──► N televisions
 *
 * One upstream connection, one poll loop, many screens. Adding the fiftieth TV
 * to an office costs a socket and nothing else — no extra vendor requests, no
 * extra licence exposure.
 *
 * Per-connection filtering matters more than it looks: a wall showing eight
 * cards subscribes to eight ids and receives frames only for those, so a busy
 * crypto tape doesn't wake a screen that is displaying Saudi banks.
 */

const HEARTBEAT_MS = 30_000;
const MAX_SUBSCRIPTIONS = 600;

interface Client {
  socket: WebSocket;
  deviceId: string | null;
  /** null = "everything the engine has", which is what a fresh screen asks for. */
  ids: Set<string> | null;
  markets: Set<MarketId> | null;
  alive: boolean;
  connectedAt: number;
}

export class Gateway {
  private wss: WebSocketServer;
  private clients = new Set<Client>();
  private byDevice = new Map<string, Set<Client>>();
  private heartbeat: NodeJS.Timeout | null = null;
  private unsubscribers: Array<() => void> = [];

  constructor(server: HttpServer, private engine: MarketEngine) {
    this.wss = new WebSocketServer({ server, path: '/stream', maxPayload: 64 * 1024 });

    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));

    // The socket server shares the HTTP server, so it re-emits its errors —
    // including the bind failure at startup. Without a handler here, Node
    // rethrows it as an unhandled 'error' event and buries the real cause in a
    // stack trace. Log it and let the HTTP layer report it properly.
    this.wss.on('error', (err: NodeJS.ErrnoException) => {
      log.error('websocket server error', { code: err.code, err: err.message });
    });

    this.unsubscribers.push(
      engine.onQuotes((quotes) => this.broadcastQuotes(quotes)),
      engine.onSnapshot((snapshot) => this.broadcastSnapshot(snapshot)),
    );

    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
  }

  close(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    this.unsubscribers.forEach((u) => u());
    this.unsubscribers = [];
    for (const c of this.clients) {
      try { c.socket.close(1001, 'server shutting down'); } catch { /* already gone */ }
    }
    this.clients.clear();
    this.byDevice.clear();
    this.wss.close();
  }

  stats() {
    return {
      connections: this.clients.size,
      devices: this.byDevice.size,
      subscriptions: [...this.clients].reduce((n, c) => n + (c.ids?.size ?? 0), 0),
    };
  }

  /** Relay a phone's configuration push to that phone's television. */
  pushConfig(deviceId: string, payload: Record<string, unknown>): number {
    const targets = this.byDevice.get(deviceId);
    if (!targets?.size) return 0;
    let delivered = 0;
    for (const client of targets) {
      if (send(client.socket, { type: 'config', data: payload })) delivered++;
    }
    return delivered;
  }

  // ------------------------------------------------------------- internals

  private onConnection(socket: WebSocket, req: IncomingMessage) {
    const url = new URL(req.url ?? '/stream', 'http://localhost');
    const token = url.searchParams.get('token');
    const claims = verifyToken(token);

    // An unpaired screen is still a legitimate viewer of public market data —
    // it just can't be addressed by a phone. Requiring a token to see prices
    // would mean a TV can't show anything until someone finds their phone.
    const deviceId = claims?.sub ?? url.searchParams.get('deviceId') ?? null;

    const client: Client = {
      socket,
      deviceId,
      ids: null,
      markets: null,
      alive: true,
      connectedAt: Date.now(),
    };

    this.clients.add(client);
    if (deviceId) {
      let set = this.byDevice.get(deviceId);
      if (!set) {
        set = new Set();
        this.byDevice.set(deviceId, set);
      }
      set.add(client);
    }

    log.info('ws connected', { deviceId, authed: !!claims, clients: this.clients.size });

    send(socket, {
      type: 'hello',
      deviceId,
      markets: this.engine.markets(),
      serverTime: Date.now(),
    });

    // Seed the screen so it paints immediately instead of waiting for a tick.
    for (const snapshot of this.engine.store.allSnapshots()) {
      send(socket, { type: 'snapshot', data: snapshot });
    }
    for (const market of this.engine.markets()) {
      const quotes = this.engine.store.forMarket(market);
      if (quotes.length) sendChunked(socket, quotes);
    }

    socket.on('message', (raw) => this.onMessage(client, raw));
    socket.on('pong', () => { client.alive = true; });
    socket.on('close', () => this.drop(client));
    socket.on('error', (err) => {
      log.debug('ws error', { deviceId, err: err.message });
      this.drop(client);
    });
  }

  private onMessage(client: Client, raw: unknown) {
    let frame: ClientFrame;
    try {
      frame = JSON.parse(String(raw)) as ClientFrame;
    } catch {
      send(client.socket, { type: 'error', message: 'malformed frame' });
      return;
    }

    switch (frame.type) {
      case 'subscribe': {
        const ids = Array.isArray(frame.ids) ? frame.ids.filter((s) => typeof s === 'string') : [];
        if (!ids.length) {
          // Empty subscribe means "send me everything" — how a wall starts up.
          client.ids = null;
        } else {
          client.ids ??= new Set();
          for (const id of ids) {
            if (client.ids.size >= MAX_SUBSCRIPTIONS) break;
            client.ids.add(id);
          }
          // Answer immediately from cache rather than making the screen wait
          // for the next tick of a market that might be closed.
          const seeded = this.engine.quotes([...client.ids]);
          if (seeded.length) sendChunked(client.socket, seeded);
        }
        if (frame.market) {
          client.markets ??= new Set();
          client.markets.add(frame.market);
        }
        break;
      }

      case 'unsubscribe': {
        if (!client.ids) break;
        for (const id of frame.ids ?? []) client.ids.delete(id);
        break;
      }

      case 'ping':
        send(client.socket, { type: 'pong', t: Date.now() });
        break;

      default:
        send(client.socket, { type: 'error', message: 'unknown frame type' });
    }
  }

  private drop(client: Client) {
    if (!this.clients.delete(client)) return;
    if (client.deviceId) {
      const set = this.byDevice.get(client.deviceId);
      set?.delete(client);
      if (set && !set.size) this.byDevice.delete(client.deviceId);
    }
    log.debug('ws disconnected', { deviceId: client.deviceId, clients: this.clients.size });
  }

  private broadcastQuotes(quotes: Quote[]) {
    if (!this.clients.size || !quotes.length) return;
    for (const client of this.clients) {
      const slice = client.ids ? quotes.filter((q) => client.ids!.has(q.id)) : quotes;
      if (slice.length) sendChunked(client.socket, slice);
    }
  }

  private broadcastSnapshot(snapshot: MarketSnapshot) {
    for (const client of this.clients) {
      if (client.markets && !client.markets.has(snapshot.market)) continue;
      send(client.socket, { type: 'snapshot', data: snapshot });
    }
  }

  /** Drop connections that stopped answering — a TV that lost power leaves a socket behind. */
  private sweep() {
    for (const client of this.clients) {
      if (!client.alive) {
        try { client.socket.terminate(); } catch { /* already gone */ }
        this.drop(client);
        continue;
      }
      client.alive = false;
      try { client.socket.ping(); } catch { this.drop(client); }
    }
  }
}

function send(socket: WebSocket, frame: ServerFrame): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(frame));
    return true;
  } catch {
    return false;
  }
}

/**
 * A first-connect seed can be several hundred quotes. Splitting it keeps any
 * single frame small enough that a TV's modest JSON parser doesn't stall the
 * render thread.
 */
function sendChunked(socket: WebSocket, quotes: Quote[], chunk = 120) {
  for (let i = 0; i < quotes.length; i += chunk) {
    send(socket, { type: 'quotes', data: quotes.slice(i, i + chunk) });
  }
}
