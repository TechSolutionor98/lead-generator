import { Country, State, City } from 'country-state-city';
import { REGIONS as RU_REGIONS } from './regions.js';

/**
 * Country → region/state → city catalogue for the location picker.
 *
 * Backed by the offline `country-state-city` dataset (250 countries, all their
 * states/provinces and cities) so ANY country auto-populates its regions and
 * cities — no typing required and no network call. Two markets are kept
 * hand-curated as overrides: Russia (Cyrillic names, since the whole tool's
 * queries + geocoding run in Russian) and the UAE (the operator's home market).
 *
 * The picker fetches lazily: countries up front, a country's regions when it is
 * selected, a region's cities when it is selected.
 */

export interface NamedCode {
  name: string;
  code: string; // ISO code for dataset lookups; for curated entries, the name itself (an opaque handle)
}

// Curated overrides, keyed by lowercase ISO country code.
const CURATED: Record<string, Record<string, string[]>> = {
  ru: RU_REGIONS,
  ae: {
    Dubai: ['Dubai', 'Deira', 'Bur Dubai', 'Jebel Ali', 'Dubai Investment Park'],
    'Abu Dhabi': ['Abu Dhabi', 'Al Ain', 'Mussafah'],
    Sharjah: ['Sharjah', 'Al Nahda'],
    Ajman: ['Ajman'],
    'Ras Al Khaimah': ['Ras Al Khaimah'],
    Fujairah: ['Fujairah'],
    'Umm Al Quwain': ['Umm Al Quwain'],
  },
};

// Pin the most-used markets to the top of the dropdown, then the rest A→Z.
const PINNED = ['RU', 'AE'];

/** All selectable countries ({ name, code }), pinned markets first. */
export function listCountries(): NamedCode[] {
  const all = Country.getAllCountries().map((c) => ({ name: c.name, code: c.isoCode.toLowerCase() }));
  const pinned = PINNED.map((iso) => all.find((c) => c.code === iso.toLowerCase())).filter(
    (c): c is NamedCode => Boolean(c),
  );
  const rest = all
    .filter((c) => !PINNED.map((p) => p.toLowerCase()).includes(c.code))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...pinned, ...rest];
}

/** Regions/states for a country. For curated countries, `code` is the region name. */
export function regionsFor(countryCode: string): NamedCode[] {
  const code = countryCode.toLowerCase();
  if (CURATED[code]) {
    return Object.keys(CURATED[code]).map((name) => ({ name, code: name }));
  }
  return State.getStatesOfCountry(code.toUpperCase())
    .map((s) => ({ name: s.name, code: s.isoCode }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Cities for a region. `regionCode` is a state ISO code, or a region name for curated countries. */
export function citiesFor(countryCode: string, regionCode: string): string[] {
  const code = countryCode.toLowerCase();
  if (CURATED[code]) {
    return CURATED[code][regionCode] ?? [];
  }
  return City.getCitiesOfState(code.toUpperCase(), regionCode)
    .map((c) => c.name)
    .sort((a, b) => a.localeCompare(b));
}
