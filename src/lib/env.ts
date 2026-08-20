import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * ============================================================================
 * .env loader — zero dependency, cross-platform
 * ============================================================================
 *
 * Why this exists rather than telling people to prefix the command:
 * `FOO=bar npm run dev` is Unix shell syntax. On Windows `cmd.exe` it fails
 * with "'FOO' is not recognized as an internal or external command", which is
 * a confusing first experience for something that is not the user's mistake.
 *
 * So configuration comes from a file on every platform, and `npm run dev` is
 * the same command everywhere.
 *
 * Real environment variables always win. On Railway, Render or Docker the
 * platform injects them and this loader finds no file and does nothing —
 * which is exactly right: a stray `.env` committed by accident must never
 * override production configuration.
 */

let loaded = false;

export function loadEnvFile(path = '.env'): { loaded: boolean; count: number; path: string } {
  const full = resolve(process.cwd(), path);
  if (loaded) return { loaded: true, count: 0, path: full };

  let raw: string;
  try {
    raw = readFileSync(full, 'utf8');
  } catch {
    // No file is the normal case in production.
    return { loaded: false, count: 0, path: full };
  }

  // Parse the whole file first so a repeated key resolves to its LAST value.
  // That is what makes `echo KEY=value >> .env` work — appending to the end of
  // the file overrides the same key earlier in it, which is exactly what a
  // person expects when they add a line to the bottom.
  const parsed = new Map<string, string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;

    let value = trimmed.slice(eq + 1).trim();

    // Strip matching quotes, and honour \n inside double quotes only.
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n');
    } else {
      // Unquoted values may carry a trailing comment.
      const hash = value.indexOf(' #');
      if (hash >= 0) value = value.slice(0, hash).trim();
    }

    parsed.set(key, value);
  }

  // A variable already present in the real environment beats the file, always.
  // On Railway, Render or Docker the platform's variables must win over a
  // stray .env that happened to get committed.
  let count = 0;
  for (const [key, value] of parsed) {
    if (process.env[key] !== undefined) continue;
    process.env[key] = value;
    count++;
  }

  loaded = true;
  return { loaded: true, count, path: full };
}
