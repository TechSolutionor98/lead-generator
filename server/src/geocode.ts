import PQueue from 'p-queue';
import { http } from './http.js';
import { getGeoCache, setGeoCache } from './db.js';
import { CITIES } from './geo.js';
import type { GeoBox } from './types.js';

/**
 * Resolve any Russian region or city name to a GeoBox (center + bbox + span)
 * using OpenStreetMap's free Nominatim geocoder. Results are cached in SQLite,
 * so each place is fetched at most once ever.
 *
 * Nominatim usage policy: max ~1 request/second and a valid User-Agent. We
 * honor both (the shared http client sets the UA; this queue paces to 1/s).
 */

const NOMINATIM = 'https://nominatim.openstreetmap.org/search';
const geoQueue = new PQueue({ concurrency: 1, interval: 1100, intervalCap: 1 });

interface NominatimHit {
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string]; // [south, north, west, east]
}

function hitToBox(hit: NominatimHit): GeoBox {
  const south = parseFloat(hit.boundingbox[0]);
  const north = parseFloat(hit.boundingbox[1]);
  const west = parseFloat(hit.boundingbox[2]);
  const east = parseFloat(hit.boundingbox[3]);
  return {
    center: [parseFloat(hit.lon), parseFloat(hit.lat)],
    spn: [Math.abs(east - west), Math.abs(north - south)],
    bbox: [south, west, north, east],
  };
}

async function nominatim(query: string, countryCode: string): Promise<GeoBox | undefined> {
  const res = await http.get<NominatimHit[]>(NOMINATIM, {
    params: {
      q: query,
      format: 'jsonv2',
      limit: 1,
      // Scope results to the selected country (ISO 3166-1 alpha-2).
      ...(countryCode ? { countrycodes: countryCode } : {}),
    },
    timeout: 15_000,
  });
  if (res.status >= 400 || !Array.isArray(res.data) || res.data.length === 0) return undefined;
  return hitToBox(res.data[0]);
}

/**
 * Resolve a (country, region?, city?) target to a GeoBox. From narrow to broad:
 *   - city given → geocode "city, region, country"
 *   - region only → geocode "region, country"
 *   - neither → geocode the whole country
 * Results are cached by place string, so each place is fetched at most once.
 */
export async function resolveGeo(
  countryCode: string,
  country: string,
  region: string | undefined,
  city: string | undefined,
  log?: (m: string) => void,
): Promise<GeoBox | undefined> {
  // Fast path: the Russian seed cities have hand-tuned boxes already.
  if (countryCode === 'ru' && city && CITIES[city]) {
    const c = CITIES[city];
    return { center: c.center, spn: c.spn, bbox: c.bbox };
  }

  // Cache key is namespaced by country so same-named places don't collide.
  const parts = [city, region, country].filter(Boolean) as string[];
  const key = `${countryCode}|${parts.join(', ')}`;
  try {
    const cached = await getGeoCache(key);
    if (cached) return cached;
  } catch (err) {
    // A geo-cache miss must never block geocoding — fall through to Nominatim.
    log?.(`[geo] cache unavailable (${(err as Error).message}); geocoding live`);
  }

  const query = parts.join(', ');
  try {
    const box = await geoQueue.add(() => nominatim(query, countryCode));
    if (box) {
      await setGeoCache(key, box).catch(() => undefined);
      return box;
    }
    log?.(`[geo] could not locate "${query}"`);
  } catch (err) {
    log?.(`[geo] lookup failed for "${query}": ${(err as Error).message}`);
  }
  return undefined;
}
