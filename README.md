# MARKET WALL — Backend

Normalises licensed market feeds and fans them out to television screens over
one WebSocket. Node 22 · TypeScript · Fastify · Postgres · Redis.

This is Phase 2 of the roadmap, plus the pairing half of Phase 3.

---

## What it does

```
   vendor ──► adapter ──► engine ──► gateway ──► N televisions
              normalise   schedule   fan-out
                          budget
                          cache
```

- **One upstream connection per market, regardless of how many screens.** Adding
  the fiftieth TV to an office costs a socket and nothing else — no extra vendor
  requests, no extra licence exposure.
- **Vendor keys never leave this process.** The TV authenticates to *your* API
  with a device token issued at pairing (spec §40).
- **Poll intervals are calculated, not guessed.** The engine divides your plan's
  daily allowance by the length of the trading session and holds back 30 % for
  on-demand traffic. Change plan, change one number, the interval follows.
- **A closed market costs nothing.** Polling stops outside session hours, which
  is where most of a budget would otherwise be wasted.
- **Data status is structural.** A delayed licence cannot produce a `live` quote;
  the clamp is enforced in the adapter and again on the TV.

---

## Quick start

```bash
cp .env.example .env      # then fill in your keys
npm install
npm run dev               # http://localhost:8080
```

No keys yet? This runs a full wall with no credentials at all:

```bash
ALLOW_SIMULATED=true npm run dev
```

Every quote is stamped `simulated` and the TV badges it blue. It is not possible
to configure this data to appear live.

Check it is working:

```bash
curl localhost:8080/health
curl localhost:8080/v1/status | jq
```

---

## Data sources

| Market | Vendor | Status published | Cost |
|---|---|---|---|
| Saudi (TASI/NOMU) | [SAHMK](https://www.sahmk.sa/en/developers) | `DELAYED` (15 min) → `LIVE` on Pro | Free tier · $149/mo Starter · $499/mo Pro |
| US (NASDAQ/NYSE) | [Twelve Data](https://twelvedata.com/pricing) | `LIVE` | Free tier · $79/mo Grow |
| Crypto | [Binance public](https://binance-docs.github.io/apidocs/spot/en/) | `LIVE` | Free, no key |

### SAHMK, plan by plan

The adapter changes shape with your tier, because the endpoints you may call do:

| Plan | Requests/day | Endpoints used | Resulting refresh |
|---|---|---|---|
| **Free** | 100 | `market/summary` + gainers/losers/volume/value | ~23 min |
| **Starter** | 5 000 | adds bulk `/quotes/` and `/historical/` | ~16 s |
| **Pro** | 50 000 | adds real-time WebSocket | ~10 s |

On the Free plan there is no bulk quote endpoint, so the tape is assembled from
the four ranked lists — which between them cover the names anyone is actually
watching. That is five requests per cycle and it puts a real Saudi wall on a
television for nothing.

Set the plan honestly and the maths takes care of itself:

```env
SAHMK_DAILY_BUDGET=100      # Free
SAHMK_BULK_QUOTES=false     # Starter and above only
SAHMK_DATA_MODE=delayed     # hard ceiling — see below
```

> **Licensing.** SAHMK's terms restrict redistribution and commercial display;
> a TV product is commercial display. Raise it with their commercial team before
> launch. The `DELAYED 15 MIN` badge and the `declaredStatus` ceiling keep the
> app compliant by construction, but the contract is still yours to sign.

### Twelve Data credits

Credits, not requests: `/quote?symbol=A,B,C` is one HTTP call but costs one
credit per symbol. With the Basic plan (800/day, 8/min) and 24 tracked symbols
the engine settles on a refresh every ~17 minutes. On Grow, raise
`TWELVEDATA_SYMBOL_LIMIT` to 60–80 and the interval drops under a minute by
itself.

---

## The delayed ceiling

The rule the whole system is built around (spec §57): **a price is never
rendered as LIVE unless the feed is licensed to be live.**

It is enforced three times, deliberately:

1. `SAHMK_DATA_MODE=delayed` makes the adapter publish `delayed` even if the
   upstream sets `is_delayed: false`.
2. The engine relabels everything `cached` after three consecutive upstream
   failures, so a dead feed cannot keep claiming freshness.
3. `VITE_SAUDI_STATUS=delayed` on the TV clamps it again on arrival.

Belt and braces on the one invariant worth paying for twice.

---

## API

Everything the TV app speaks. All responses are normalised to the shapes in
`src/market/types.ts`, which mirrors `src/core/types.ts` in the TV app.

### Market data — no auth, cache reads only

```
GET  /v1/markets/:market/instruments        → Instrument[]
GET  /v1/markets/:market/quotes?ids=a,b,c   → Quote[]      (omit ids for all)
GET  /v1/markets/:market/snapshot           → MarketSnapshot   (503 until seeded)
GET  /v1/instruments/:id/candles?range=1D   → Candle[]
GET  /v1/search?q=aramco&market=saudi       → Instrument[] with latest quote
```

`:market` is `saudi` | `us` | `crypto`. `range` is `1D|1W|1M|3M|6M|1Y|5Y`.

### WebSocket

```
WS /stream?token=<deviceToken>

→ {"type":"subscribe","market":"saudi","ids":["saudi:2222"]}
→ {"type":"unsubscribe","ids":[...]}
→ {"type":"ping"}

← {"type":"hello","deviceId":...,"markets":[...],"serverTime":...}
← {"type":"quotes","data":[Quote,...]}       only what changed
← {"type":"snapshot","data":MarketSnapshot}
← {"type":"config","data":{...}}             pushed by a paired phone
← {"type":"pong","t":...}
```

An empty `subscribe` means "everything", which is how a wall starts up. A screen
showing eight cards subscribes to eight ids and is not woken by anything else.

### Pairing

```
POST /v1/pairing/session       → { code, deviceId, deviceToken, expiresIn }
GET  /v1/pairing/:code         → { deviceId, claimed, expiresIn }
POST /v1/pairing/:code/claim   → { deviceId, remoteToken }
POST /v1/devices/:id/config    → relays to that screen's socket   [auth]
GET  /v1/devices/:id/config    → last saved configuration          [auth]
```

The code is 4 digits, lives 5 minutes and is single-use. The TV's own token is
issued at session creation and never travels in the QR payload — photographing
the screen does not hand over the device.

### Watchlists and alerts — `Authorization: Bearer <token>`

```
GET|POST         /v1/watchlists
PATCH|DELETE     /v1/watchlists/:id
GET|POST         /v1/alerts
PATCH|DELETE     /v1/alerts/:id
```

These need Postgres. Without it they return 503 rather than pretending to save.

### Operations

```
GET /health      → liveness; reports `degraded`, never fails on one bad feed
GET /v1/status   → plan, adapters, intervals, budgets spent, sockets, cache size
```

---

## Deploying to Railway

1. Push this folder to a repo and create a Railway service from it. The
   `Dockerfile` and `railway.json` are already wired, including the health check.
2. Add the **PostgreSQL** and **Redis** plugins. Railway injects `DATABASE_URL`
   and `REDIS_URL` automatically; the schema is created on first boot.
3. Set the variables from `.env.example`. At minimum:

   ```
   TOKEN_SECRET=<openssl rand -hex 32>
   SAHMK_API_KEY=...
   SAHMK_DAILY_BUDGET=100
   TWELVEDATA_API_KEY=...
   CORS_ORIGINS=https://wall.yourdomain.com
   NODE_ENV=production
   ```

4. Point the TV app at it:

   ```
   VITE_API_URL=https://your-service.up.railway.app
   VITE_SAUDI_STATUS=delayed
   VITE_US_STATUS=live
   ```

`TOKEN_SECRET` is required in production — the server refuses to start without
it rather than silently issuing tokens that die on the next deploy.

### Scaling

One instance comfortably serves hundreds of screens: the work is a poll loop and
a JSON broadcast. Before adding replicas, add Redis — otherwise each instance
polls the vendor independently and your bill multiplies by the replica count.

---

## Degradation, by design

Nothing here is all-or-nothing:

| Missing | Consequence |
|---|---|
| `REDIS_URL` | Quote cache is per-process; a deploy shows a blank wall for one poll cycle |
| `DATABASE_URL` | Pairing works in memory; watchlists and alerts return 503 |
| `SAHMK_API_KEY` | Saudi market absent (or simulated if `ALLOW_SIMULATED`) |
| `TWELVEDATA_API_KEY` | US market absent |
| Vendor down | Prices stay on screen, relabelled `CACHED`, badge changes on the TV |
| Budget exhausted | Polling pauses until the vendor's reset; last prices remain, badged |

A half-configured deployment says so in the boot log and in `/v1/status`. Half
the support cost of a service like this is someone staring at an empty screen
because one variable was never set.

---

## Adding a vendor

Implement `VendorAdapter` (`src/market/provider.ts`) — six methods, no caching,
no scheduling, no fan-out; the engine owns all of that. Then register it in
`MarketEngine.buildAdapter()`. `src/market/providers/sahmk.ts` is the reference
implementation and shows the plan-aware pattern.

## Layout

```
src/
  config.ts              env schema; every secret enters here
  lib/       logger (redacts credentials) · http (retry, backoff) · budget maths
  market/
    types.ts             THE WIRE CONTRACT — mirrors the TV's core/types.ts
    provider.ts          VendorAdapter interface
    providers/           sahmk · twelvedata · binance · simulated
    reference/           sectors, Arabic names, approximate caps
    engine.ts            scheduling, budgeting, degradation, fan-out
    store.ts             hot cache, sparkline history, Redis persistence
    session.ts           exchange clocks in the exchange's own timezone
  http/                  Fastify server and routes
  ws/gateway.ts          one socket per screen, filtered per subscription
  db/                    optional Postgres schema and pool
  auth/tokens.ts         signed device tokens, constant-time verification
```

---

## Note on reference data

`src/market/reference/` carries sector classification, Arabic names and
approximate market capitalisations. It exists because sector and cap are either
absent from quote payloads or cost one request per symbol — which would spend a
whole day's Free-tier budget just to draw a heatmap. The vendor supplies prices;
this supplies classification. The cap figures size heatmap tiles and are never
displayed to the user as current.
