import type { Instrument } from '../types.js';

/**
 * Crypto universe. Symbols map 1:1 to Binance USDT spot pairs
 * (`${symbol}USDT`), which is what BinanceCryptoProvider streams.
 * Caps are approximate reference values in billions of USD, used only for
 * heatmap sizing; the live feed supplies price/volume.
 */
const raw: Array<[string, string, string, string, number]> = [
  ['BTC', 'Bitcoin', 'بيتكوين', 'majors', 2200],
  ['ETH', 'Ethereum', 'إيثيريوم', 'majors', 480],
  ['BNB', 'BNB', 'بي إن بي', 'majors', 95],
  ['SOL', 'Solana', 'سولانا', 'layer1', 90],
  ['XRP', 'XRP', 'ريبل', 'payments', 130],
  ['DOGE', 'Dogecoin', 'دوجكوين', 'meme', 30],
  ['ADA', 'Cardano', 'كاردانو', 'layer1', 25],
  ['TRX', 'TRON', 'ترون', 'layer1', 22],
  ['AVAX', 'Avalanche', 'أفالانش', 'layer1', 15],
  ['LINK', 'Chainlink', 'تشين لينك', 'defi', 14],
  ['DOT', 'Polkadot', 'بولكادوت', 'layer1', 9],
  ['MATIC', 'Polygon', 'بوليجون', 'layer2', 6],
  ['LTC', 'Litecoin', 'لايتكوين', 'payments', 8],
  ['BCH', 'Bitcoin Cash', 'بيتكوين كاش', 'payments', 9],
  ['UNI', 'Uniswap', 'يونيسواب', 'defi', 7],
  ['ATOM', 'Cosmos', 'كوزموس', 'layer1', 4],
  ['ETC', 'Ethereum Classic', 'إيثيريوم كلاسيك', 'layer1', 4],
  ['XLM', 'Stellar', 'ستيلر', 'payments', 8],
  ['NEAR', 'NEAR Protocol', 'نير', 'layer1', 6],
  ['APT', 'Aptos', 'أبتوس', 'layer1', 5],
  ['ARB', 'Arbitrum', 'أربيتروم', 'layer2', 3],
  ['OP', 'Optimism', 'أوبتيميزم', 'layer2', 2],
  ['FIL', 'Filecoin', 'فايل كوين', 'infra', 3],
  ['ICP', 'Internet Computer', 'إنترنت كمبيوتر', 'infra', 5],
  ['INJ', 'Injective', 'إنجكتيف', 'defi', 3],
  ['SUI', 'Sui', 'سوي', 'layer1', 9],
  ['TIA', 'Celestia', 'سيليستيا', 'infra', 2],
  ['SEI', 'Sei', 'ساي', 'layer1', 2],
  ['AAVE', 'Aave', 'آفي', 'defi', 4],
  ['SHIB', 'Shiba Inu', 'شيبا إينو', 'meme', 12],
  ['PEPE', 'Pepe', 'بيبي', 'meme', 5],
  ['RNDR', 'Render', 'رندر', 'infra', 3],
];

export const CRYPTO_UNIVERSE: Instrument[] = raw.map(([symbol, nameEn, nameAr, sector, cap]) => ({
  id: `crypto:${symbol}`,
  market: 'crypto' as const,
  symbol,
  nameEn,
  nameAr,
  sector,
  currency: 'USD' as const,
  marketCap: cap * 1e9,
}));

export const CRYPTO_SECTORS = ['majors', 'layer1', 'layer2', 'defi', 'payments', 'infra', 'meme'] as const;
