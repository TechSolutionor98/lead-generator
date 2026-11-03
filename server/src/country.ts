import { Country } from 'country-state-city';

/**
 * Per-country metadata used to make the scrapers location-aware instead of
 * Russia-only. Two things vary by the country being searched:
 *
 *   1. Phone formatting — the international dial code, the national trunk prefix
 *      to strip, and the plausible national length (so a Pakistani number
 *      normalizes to +92…, not a bogus +7…).
 *   2. Search UI locale — the Google/Bing language (`hl`) + region (`gl`) so a
 *      Pakistan search returns English category labels ("Computer store"), not
 *      Russian ones ("Компьютерный магазин").
 *
 * Dial codes come from the offline `country-state-city` dataset (every country
 * has one). A few key markets get hand-tuned trunk/length overrides; everything
 * else uses a sane generic default. Language is Russian for Russia (the tool's
 * home market, whose whole query set is Russian) and English everywhere else.
 */

export interface CountryMeta {
  /** International calling code, digits only, no "+". */
  dial: string;
  /** National trunk prefix to strip before prefixing the dial code. */
  trunk: string;
  /** Plausible national significant-number length (after the dial code). */
  natMin: number;
  natMax: number;
  /** Google/Bing UI language (`hl` / `setlang`). */
  hl: string;
  /** Google/Bing region bias (`gl` / `cc`), uppercase ISO 3166-1 alpha-2. */
  gl: string;
}

// Hand-tuned overrides for the markets that matter most. Everything else is
// derived from the dataset with a generic trunk/length.
const OVERRIDES: Record<string, CountryMeta> = {
  ru: { dial: '7', trunk: '8', natMin: 10, natMax: 10, hl: 'ru', gl: 'RU' },
  pk: { dial: '92', trunk: '0', natMin: 9, natMax: 10, hl: 'en', gl: 'PK' },
  ae: { dial: '971', trunk: '0', natMin: 8, natMax: 9, hl: 'en', gl: 'AE' },
  in: { dial: '91', trunk: '0', natMin: 10, natMax: 10, hl: 'en', gl: 'IN' },
  gb: { dial: '44', trunk: '0', natMin: 9, natMax: 10, hl: 'en', gl: 'GB' },
  us: { dial: '1', trunk: '1', natMin: 10, natMax: 10, hl: 'en', gl: 'US' },
};

/** The default market when no country is given (the tool's primary market). */
const DEFAULT = OVERRIDES.ru;

/**
 * Resolve metadata for a country (ISO 3166-1 alpha-2). Unknown/empty codes fall
 * back to the default (Russia) so legacy call sites keep working unchanged.
 */
export function countryMeta(code?: string): CountryMeta {
  const c = (code || '').trim().toLowerCase();
  if (!c) return DEFAULT;
  if (OVERRIDES[c]) return OVERRIDES[c];

  // Derive the dial code from the offline dataset for any other country.
  const info = Country.getCountryByCode(c.toUpperCase());
  const dial = (info?.phonecode || '').match(/\d{1,4}/)?.[0] || '';
  if (!dial) return DEFAULT;

  return { dial, trunk: '0', natMin: 6, natMax: 13, hl: 'en', gl: c.toUpperCase() };
}
