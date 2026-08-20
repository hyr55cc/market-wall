import { log } from './logger.js';

export class UpstreamError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(message);
    this.name = 'UpstreamError';
  }
}

export interface FetchJsonOptions {
  headers?: Record<string, string>;
  timeoutMs?: number;
  /** Retries for transient failures only (network, 5xx, 429). */
  retries?: number;
  /** Label used in logs so you can tell which vendor misbehaved. */
  source: string;
  signal?: AbortSignal;
}

/**
 * One JSON fetch helper for every vendor, so timeouts, retries, backoff and
 * rate-limit headers behave identically no matter whose API is on the other end.
 *
 * A 429 is retryable and honours `Retry-After`. A 4xx that isn't 429 is not
 * retried — a bad key or a symbol you aren't entitled to will not fix itself,
 * and hammering it is how accounts get suspended.
 */
export async function fetchJson<T>(url: string, opts: FetchJsonOptions): Promise<{ data: T; headers: Headers }> {
  const { headers = {}, timeoutMs = 12_000, retries = 2, source } = opts;
  let attempt = 0;
  let lastError: unknown;

  while (attempt <= retries) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = () => controller.abort();
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const res = await fetch(url, {
        headers: { accept: 'application/json', ...headers },
        signal: controller.signal,
      });

      if (res.ok) {
        const data = (await res.json()) as T;
        return { data, headers: res.headers };
      }

      const body = await res.text().catch(() => '');
      const retryable = res.status === 429 || res.status >= 500;
      if (!retryable || attempt === retries) {
        throw new UpstreamError(`${source} responded ${res.status}`, res.status, retryable, body.slice(0, 400));
      }

      const retryAfter = Number(res.headers.get('retry-after'));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : backoff(attempt);
      log.warn('upstream retry', { source, status: res.status, attempt, waitMs: wait });
      await sleep(wait);
    } catch (err) {
      lastError = err;
      if (err instanceof UpstreamError) throw err;
      if (attempt === retries) break;
      const wait = backoff(attempt);
      log.warn('upstream network retry', { source, attempt, waitMs: wait, err: String(err) });
      await sleep(wait);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
    attempt++;
  }

  throw new UpstreamError(`${source} unreachable: ${String(lastError)}`, 0, true);
}

function backoff(attempt: number): number {
  return Math.min(8000, 500 * 2 ** attempt) * (0.7 + Math.random() * 0.6);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function qs(params: Record<string, string | number | boolean | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== '') sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}
