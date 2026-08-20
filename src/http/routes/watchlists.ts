import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { bearerFrom, newId, verifyToken } from '../../auth/tokens.js';
import { dbReady, query } from '../../db/index.js';

/**
 * Watchlists and alerts, scoped to a paired device (spec §12, §17, §23).
 *
 * Owner is the device today and becomes the user account when sign-in lands in
 * a later phase — `owner_kind` is already in the schema so that migration is a
 * data change, not a redesign.
 *
 * Every route here needs Postgres. Without it they return 503 rather than
 * pretending to save, because a watchlist that silently vanishes on the next
 * reboot is worse than one the user was told they can't have yet.
 */

interface Ctx {
  ownerId: string;
  ownerKind: 'device';
}

function authenticate(req: FastifyRequest, reply: FastifyReply): Ctx | null {
  const claims = verifyToken(bearerFrom(req.headers as Record<string, unknown>));
  if (!claims) {
    reply.code(401).send({ error: 'unauthorized' });
    return null;
  }
  return { ownerId: claims.sub, ownerKind: 'device' };
}

function requireDb(reply: FastifyReply): boolean {
  if (dbReady()) return true;
  reply.code(503).send({ error: 'persistence not configured', hint: 'set DATABASE_URL' });
  return false;
}

interface WatchlistRow {
  id: string;
  name: string;
  instrument_ids: string[];
  position: number;
}

interface AlertRow {
  id: string;
  instrument_id: string;
  kind: string;
  value: number;
  enabled: boolean;
  fired_at: Date | null;
}

export function registerWatchlistRoutes(app: FastifyInstance) {
  // ------------------------------------------------------------ watchlists

  app.get('/v1/watchlists', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    const rows = await query<WatchlistRow>(
      `SELECT id, name, instrument_ids, position
         FROM watchlists
        WHERE owner_kind = $1 AND owner_id = $2
        ORDER BY position, name`,
      [ctx.ownerKind, ctx.ownerId],
    );
    return rows.map((r) => ({ id: r.id, name: r.name, ids: r.instrument_ids, position: r.position }));
  });

  app.post<{ Body: { name?: string; ids?: string[] } }>('/v1/watchlists', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    const name = (req.body?.name ?? '').trim().slice(0, 60) || 'My Stocks';
    const ids = sanitizeIds(req.body?.ids);
    const id = newId('wl');

    await query(
      `INSERT INTO watchlists (id, owner_id, owner_kind, name, instrument_ids, position)
       VALUES ($1, $2, $3, $4, $5,
               COALESCE((SELECT MAX(position) + 1 FROM watchlists WHERE owner_kind = $3 AND owner_id = $2), 0))`,
      [id, ctx.ownerId, ctx.ownerKind, name, ids],
    );

    return reply.code(201).send({ id, name, ids });
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; ids?: string[]; position?: number } }>(
    '/v1/watchlists/:id',
    async (req, reply) => {
      const ctx = authenticate(req, reply);
      if (!ctx || !requireDb(reply)) return;

      const updated = await query<WatchlistRow>(
        `UPDATE watchlists
            SET name = COALESCE($4, name),
                instrument_ids = COALESCE($5, instrument_ids),
                position = COALESCE($6, position),
                updated_at = now()
          WHERE id = $1 AND owner_kind = $2 AND owner_id = $3
      RETURNING id, name, instrument_ids, position`,
        [
          req.params.id,
          ctx.ownerKind,
          ctx.ownerId,
          req.body?.name?.trim().slice(0, 60) ?? null,
          req.body?.ids ? sanitizeIds(req.body.ids) : null,
          typeof req.body?.position === 'number' ? req.body.position : null,
        ],
      );

      if (!updated.length) return reply.code(404).send({ error: 'not found' });
      const row = updated[0];
      return { id: row.id, name: row.name, ids: row.instrument_ids, position: row.position };
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/watchlists/:id', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    await query(`DELETE FROM watchlists WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`, [
      req.params.id,
      ctx.ownerKind,
      ctx.ownerId,
    ]);
    return reply.code(204).send();
  });

  // ---------------------------------------------------------------- alerts

  app.get('/v1/alerts', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    const rows = await query<AlertRow>(
      `SELECT id, instrument_id, kind, value, enabled, fired_at
         FROM alerts
        WHERE owner_kind = $1 AND owner_id = $2
        ORDER BY created_at DESC`,
      [ctx.ownerKind, ctx.ownerId],
    );
    return rows.map((r) => ({
      id: r.id,
      instrumentId: r.instrument_id,
      kind: r.kind,
      value: Number(r.value),
      enabled: r.enabled,
      firedAt: r.fired_at ? new Date(r.fired_at).getTime() : undefined,
    }));
  });

  app.post<{ Body: { instrumentId?: string; kind?: string; value?: number } }>(
    '/v1/alerts',
    async (req, reply) => {
      const ctx = authenticate(req, reply);
      if (!ctx || !requireDb(reply)) return;

      const instrumentId = (req.body?.instrumentId ?? '').trim();
      const kind = (req.body?.kind ?? '').trim();
      const value = Number(req.body?.value);

      const KINDS = ['above', 'below', 'pctUp', 'pctDown', 'volume'];
      if (!instrumentId || !KINDS.includes(kind) || !Number.isFinite(value)) {
        return reply.code(400).send({ error: 'instrumentId, kind and numeric value are required' });
      }

      const id = newId('al');
      await query(
        `INSERT INTO alerts (id, owner_id, owner_kind, instrument_id, kind, value)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, ctx.ownerId, ctx.ownerKind, instrumentId, kind, value],
      );
      return reply.code(201).send({ id, instrumentId, kind, value, enabled: true });
    },
  );

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>('/v1/alerts/:id', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    const rows = await query<AlertRow>(
      `UPDATE alerts SET enabled = COALESCE($4, enabled)
        WHERE id = $1 AND owner_kind = $2 AND owner_id = $3
    RETURNING id, instrument_id, kind, value, enabled, fired_at`,
      [req.params.id, ctx.ownerKind, ctx.ownerId, typeof req.body?.enabled === 'boolean' ? req.body.enabled : null],
    );
    if (!rows.length) return reply.code(404).send({ error: 'not found' });
    return { id: rows[0].id, enabled: rows[0].enabled };
  });

  app.delete<{ Params: { id: string } }>('/v1/alerts/:id', async (req, reply) => {
    const ctx = authenticate(req, reply);
    if (!ctx || !requireDb(reply)) return;

    await query(`DELETE FROM alerts WHERE id = $1 AND owner_kind = $2 AND owner_id = $3`, [
      req.params.id,
      ctx.ownerKind,
      ctx.ownerId,
    ]);
    return reply.code(204).send();
  });
}

/** Keep list payloads sane: unique, well-formed ids, bounded length. */
function sanitizeIds(ids: unknown): string[] {
  if (!Array.isArray(ids)) return [];
  const seen = new Set<string>();
  for (const raw of ids) {
    if (typeof raw !== 'string') continue;
    const id = raw.trim();
    if (!/^(saudi|us|crypto):[A-Za-z0-9._-]{1,20}$/.test(id)) continue;
    seen.add(id);
    if (seen.size >= 300) break;
  }
  return [...seen];
}
