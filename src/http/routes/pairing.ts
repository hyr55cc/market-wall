import type { FastifyInstance } from 'fastify';
import { dbReady, query } from '../../db/index.js';
import { issueToken, newId, pairingCode, verifyToken, bearerFrom } from '../../auth/tokens.js';
import { log } from '../../lib/logger.js';

/**
 * ============================================================================
 * QR pairing (spec §14–16)
 * ============================================================================
 *
 *   TV     POST /v1/pairing/session        → { code, deviceId, deviceToken }
 *   phone  GET  /v1/pairing/:code          → what am I about to control?
 *   phone  POST /v1/pairing/:code/claim    → { remoteToken }
 *   phone  POST /v1/devices/:id/config     → pushed to the TV over the socket
 *
 * Security properties, deliberately modest because that is all this needs:
 *  - the code is 4 digits but lives for 5 minutes and is single-use
 *  - claiming it grants control of exactly one screen, nothing else
 *  - the TV's own token is issued at session creation and never travels in the
 *    QR payload, so photographing the screen does not hand over the device
 *  - no account, no password, no personal data — scan and go
 */

const CODE_TTL_MS = 5 * 60_000;

interface PairingRow {
  code: string;
  device_id: string;
  claimed: boolean;
  expires_at: Date;
}

/** In-memory fallback so pairing still demonstrates without Postgres. */
const memory = new Map<string, { deviceId: string; claimed: boolean; expiresAt: number }>();

export function registerPairingRoutes(app: FastifyInstance) {
  const store = {
    async put(code: string, deviceId: string) {
      const expiresAt = Date.now() + CODE_TTL_MS;
      if (dbReady()) {
        await query(
          `INSERT INTO pairing_sessions (code, device_id, expires_at)
           VALUES ($1, $2, to_timestamp($3 / 1000.0))
           ON CONFLICT (code) DO UPDATE SET device_id = $2, claimed = false, expires_at = to_timestamp($3 / 1000.0)`,
          [code, deviceId, expiresAt],
        );
      } else {
        memory.set(code, { deviceId, claimed: false, expiresAt });
      }
    },

    async get(code: string): Promise<{ deviceId: string; claimed: boolean; expiresAt: number } | null> {
      if (dbReady()) {
        const rows = await query<PairingRow>(
          `SELECT code, device_id, claimed, expires_at FROM pairing_sessions WHERE code = $1`,
          [code],
        );
        const row = rows[0];
        if (!row) return null;
        return {
          deviceId: row.device_id,
          claimed: row.claimed,
          expiresAt: new Date(row.expires_at).getTime(),
        };
      }
      return memory.get(code) ?? null;
    },

    async claim(code: string) {
      if (dbReady()) {
        await query(`UPDATE pairing_sessions SET claimed = true, claimed_at = now() WHERE code = $1`, [code]);
      } else {
        const entry = memory.get(code);
        if (entry) entry.claimed = true;
      }
    },

    async purge() {
      if (dbReady()) {
        await query(`DELETE FROM pairing_sessions WHERE expires_at < now()`).catch(() => undefined);
      } else {
        const now = Date.now();
        for (const [code, entry] of memory) if (entry.expiresAt < now) memory.delete(code);
      }
    },
  };

  // Expired codes are litter, not history.
  setInterval(() => void store.purge(), 60_000).unref();

  /** TV: start a pairing session. Returns the code to render under the QR. */
  app.post<{ Body?: { deviceId?: string; name?: string; platform?: string } }>(
    '/v1/pairing/session',
    async (req) => {
      const deviceId = req.body?.deviceId?.trim() || newId('tv');
      const name = req.body?.name?.trim() || 'TV';
      const platform = req.body?.platform?.trim() || 'unknown';

      if (dbReady()) {
        await query(
          `INSERT INTO devices (id, name, platform, last_seen_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, platform = EXCLUDED.platform, last_seen_at = now()`,
          [deviceId, name, platform],
        ).catch((err) => log.warn('device upsert failed', { err: String(err) }));
      }

      // Retry on collision — with 10 000 codes and a 5-minute window this is
      // rare, but "rare" is not "never" once a customer has a hundred screens.
      let code = pairingCode(4);
      for (let i = 0; i < 5; i++) {
        const existing = await store.get(code);
        if (!existing || existing.expiresAt < Date.now()) break;
        code = pairingCode(4);
      }

      await store.put(code, deviceId);

      return {
        code,
        deviceId,
        deviceToken: issueToken(deviceId, 'device'),
        expiresIn: Math.floor(CODE_TTL_MS / 1000),
      };
    },
  );

  /** Phone: look up a code before claiming it, so the UI can say what it found. */
  app.get<{ Params: { code: string } }>('/v1/pairing/:code', async (req, reply) => {
    const entry = await store.get(req.params.code);
    if (!entry || entry.expiresAt < Date.now()) {
      return reply.code(404).send({ error: 'code expired or not found' });
    }
    return {
      deviceId: entry.deviceId,
      claimed: entry.claimed,
      expiresIn: Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000)),
    };
  });

  /** Phone: claim the code and receive a remote token for that screen. */
  app.post<{ Params: { code: string } }>('/v1/pairing/:code/claim', async (req, reply) => {
    const entry = await store.get(req.params.code);
    if (!entry || entry.expiresAt < Date.now()) {
      return reply.code(404).send({ error: 'code expired or not found' });
    }
    if (entry.claimed) {
      // Single use. A code someone read off a screen an hour ago is worthless.
      return reply.code(409).send({ error: 'code already claimed' });
    }
    await store.claim(req.params.code);
    log.info('pairing claimed', { deviceId: entry.deviceId });

    return {
      deviceId: entry.deviceId,
      remoteToken: issueToken(entry.deviceId, 'remote', 30 * 24 * 3600),
    };
  });

  /**
   * Phone: push configuration to the screen it is paired with.
   * The frame is relayed over the device's WebSocket, so the TV updates the
   * instant the phone saves (spec §15).
   */
  app.post<{ Params: { id: string }; Body: Record<string, unknown> }>(
    '/v1/devices/:id/config',
    async (req, reply) => {
      const token = verifyToken(bearerFrom(req.headers as Record<string, unknown>));
      if (!token || token.sub !== req.params.id) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const delivered = app.marketWallGateway?.pushConfig(req.params.id, req.body ?? {}) ?? 0;

      if (dbReady()) {
        await query(
          `INSERT INTO settings (device_id, payload, updated_at)
           VALUES ($1, $2::jsonb, now())
           ON CONFLICT (device_id) DO UPDATE SET payload = EXCLUDED.payload, updated_at = now()`,
          [req.params.id, JSON.stringify(req.body ?? {})],
        ).catch((err) => log.warn('settings save failed', { err: String(err) }));
      }

      return { delivered, persisted: dbReady() };
    },
  );

  /** TV: recover the last configuration a phone pushed, after a reboot. */
  app.get<{ Params: { id: string } }>('/v1/devices/:id/config', async (req, reply) => {
    const token = verifyToken(bearerFrom(req.headers as Record<string, unknown>));
    if (!token || token.sub !== req.params.id) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!dbReady()) return reply.code(503).send({ error: 'persistence not configured' });

    const rows = await query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM settings WHERE device_id = $1`,
      [req.params.id],
    );
    return rows[0]?.payload ?? {};
  });
}
