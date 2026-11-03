import { sources as sourceRegistry } from './sources/index.js';
import { resolveGeo } from './geocode.js';
import type { GeoBox, LeadSource, Target } from './types.js';

/**
 * "How many leads are available?" estimator.
 *
 * For each keyword, asks every selected source that supports counting
 * (OSM via Overpass `out count`, 2GIS via `result.total`) how many results
 * exist across the chosen places — WITHOUT collecting them. Yandex cannot
 * report a count, so it is marked unsupported.
 *
 * Counts are a guide, not a guarantee: sources overlap (the same business may
 * appear in OSM and 2GIS), and some counted objects are filtered out when
 * actually collected. It answers "roughly how big is this keyword?".
 */

export interface EstimateInput {
  sources: string[];
  queries: string[];
  targets: Target[];
}

export interface SourceCount {
  sourceId: string;
  name: string;
  /** Available count, or null when the source can't report one / errored. */
  count: number | null;
  /** False when the source doesn't support counting (e.g. Yandex). */
  supported: boolean;
}

export interface QueryEstimate {
  query: string;
  sources: SourceCount[];
  /** Sum across supported sources (approx — sources overlap). */
  total: number | null;
}

export interface EstimateResult {
  places: string[];
  queries: QueryEstimate[];
  grandTotal: number | null;
  notes: string[];
}

interface Place {
  label: string;
  region: string;
  wholeRegion: boolean;
  geo: GeoBox;
}

export async function estimateCounts(
  input: EstimateInput,
  log?: (m: string) => void,
): Promise<EstimateResult> {
  // Resolve each target to coordinates once (same as the job runner does).
  const places: Place[] = [];
  for (const t of input.targets) {
    const geo = await resolveGeo(t.countryCode, t.country, t.region, t.city, log);
    const label = t.city || t.region || t.country;
    if (!geo) {
      log?.(`could not locate ${label} — skipping`);
      continue;
    }
    places.push({ label, region: t.region || t.country, wholeRegion: !t.city, geo });
  }

  // Count across every enabled source that CAN count (OSM, 2GIS), regardless of
  // which sources are ticked for collection — "how many are available" is about
  // the data, not your collection choices. 2GIS gives a fast, accurate total.
  const countable: LeadSource[] = [...sourceRegistry.values()].filter(
    (s) => s.enabled() && typeof s.count === 'function',
  );

  // Count one (source, query, place) — never throws; returns null on failure.
  const countOne = async (src: LeadSource, query: string, place: Place): Promise<number | null> => {
    try {
      return await src.count!({
        query,
        city: place.label,
        region: place.region,
        wholeRegion: place.wholeRegion,
        geo: place.geo,
        limit: 0,
        log,
      });
    } catch (err) {
      log?.(`[${src.id}] count failed for "${query}" / ${place.label}: ${(err as Error).message}`);
      return null;
    }
  };

  // Fire everything concurrently; the per-source rate-limit queue keeps it
  // polite, and total wall-time stays bounded instead of growing per keyword.
  const queries: QueryEstimate[] = await Promise.all(
    input.queries.map(async (query) => {
      const sourceCounts: SourceCount[] = await Promise.all(
        countable.map(async (src) => {
          const perPlace = await Promise.all(places.map((place) => countOne(src, query, place)));
          const nums = perPlace.filter((c): c is number => typeof c === 'number');
          const count = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
          return { sourceId: src.id, name: src.name, count, supported: true };
        }),
      );
      const nums = sourceCounts
        .map((s) => s.count)
        .filter((c): c is number => typeof c === 'number');
      const total = nums.length ? nums.reduce((a, b) => a + b, 0) : null;
      return { query, sources: sourceCounts, total };
    }),
  );

  const totals = queries.map((q) => q.total).filter((t): t is number => typeof t === 'number');
  const grandTotal = totals.length ? totals.reduce((a, b) => a + b, 0) : null;

  return {
    places: places.map((p) => p.label),
    queries,
    grandTotal,
    notes: [
      'Counts are approximate — sources overlap, so the same business may be counted more than once.',
      'Yandex does not report a count (it has to be scraped), so it shows “n/a”.',
    ],
  };
}
