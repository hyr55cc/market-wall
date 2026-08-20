import type { Instrument, MarketId } from '../types.js';
import { SAUDI_UNIVERSE } from './saudi.js';
import { US_UNIVERSE } from './us.js';
import { CRYPTO_UNIVERSE } from './crypto.js';

/**
 * Static reference data: Arabic names, sector classification and approximate
 * market capitalisation.
 *
 * Why this exists even though we have a live vendor: sector and market cap are
 * either not in the quote payload at all, or cost one request per symbol to
 * fetch — which would eat a whole day's budget on the Free plan just to draw a
 * heatmap. So the vendor supplies prices (which must be live) and this file
 * supplies classification (which barely changes).
 *
 * Refresh the caps periodically. They size heatmap tiles; they are never shown
 * to the user as a current figure.
 */

const BY_MARKET: Record<MarketId, Instrument[]> = {
  saudi: SAUDI_UNIVERSE,
  us: US_UNIVERSE,
  crypto: CRYPTO_UNIVERSE,
};

const INDEX = new Map<string, Instrument>();
for (const list of Object.values(BY_MARKET)) {
  for (const inst of list) INDEX.set(inst.id, inst);
}

export function referenceUniverse(market: MarketId): Instrument[] {
  return BY_MARKET[market] ?? [];
}

export function referenceFor(market: MarketId, symbol: string): Instrument | undefined {
  return INDEX.get(`${market}:${symbol}`);
}

/**
 * Merge vendor-supplied identity with local classification.
 * Vendor names win when present — they are the exchange's own spelling.
 */
export function enrich(
  market: MarketId,
  symbol: string,
  vendor: { nameEn?: string; nameAr?: string; sector?: string; currency?: 'USD' | 'SAR' },
): Instrument {
  const ref = referenceFor(market, symbol);
  return {
    id: `${market}:${symbol}`,
    market,
    symbol,
    nameEn: vendor.nameEn?.trim() || ref?.nameEn || symbol,
    nameAr: vendor.nameAr?.trim() || ref?.nameAr || vendor.nameEn?.trim() || symbol,
    sector: vendor.sector?.trim() || ref?.sector || 'other',
    currency: vendor.currency ?? ref?.currency ?? (market === 'saudi' ? 'SAR' : 'USD'),
    marketCap: ref?.marketCap,
  };
}

export { SAUDI_UNIVERSE, US_UNIVERSE, CRYPTO_UNIVERSE };
