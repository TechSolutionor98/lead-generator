/**
 * Shared domain types for GrabLeads.
 * Keep this mirrored (loosely) with client/src/types.ts.
 */

/** A single business lead, normalized across all sources. */
export interface Lead {
  source: string;
  name: string;
  category?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  city: string;
  lat?: number;
  lng?: number;
  rating?: number;
  reviewsCount?: number;
  sourceUrl?: string;
  collectedAt: string; // ISO timestamp
  /** Heuristic: looks like an individual / ИП rather than an organization. */
  isIndividual?: boolean;
}

/** A resolved geographic area for a search (from the geocoder). */
export interface GeoBox {
  center: [number, number]; // lon, lat
  spn: [number, number]; // dLon, dLat (half-ish span for Yandex)
  bbox: [number, number, number, number]; // south, west, north, east (Overpass order)
}

/**
 * One search target, from broad to narrow:
 *   - country only            → search the whole country
 *   - country + region        → search the whole region/state
 *   - country + region + city → search that city
 */
export interface Target {
  country: string; // display name, e.g. "Russia"
  countryCode: string; // ISO 3166-1 alpha-2, e.g. "ru" (scopes the geocoder)
  region?: string; // region/state; omitted → whole country
  city?: string; // city; omitted → whole region (or whole country if no region)
}

/** Parameters a source adapter receives for one (query, place) search. */
export interface SearchParams {
  query: string;
  /** Display label + text-query term: the city name, or the region when whole-region. */
  city: string;
  /** The region this search belongs to. */
  region: string;
  /** Country display name, e.g. "Pakistan". */
  country: string;
  /** ISO 3166-1 alpha-2 of the search, e.g. "pk" — drives locale + phone format. */
  countryCode: string;
  /** Whether this is a whole-region search (no specific city). */
  wholeRegion: boolean;
  /** Resolved coordinates/bbox for this place. */
  geo: GeoBox;
  limit: number;
  /** Optional: a callback for human-readable progress lines. */
  log?: (message: string) => void;
  /** Optional: an AbortSignal so long scrapes can be cancelled. */
  signal?: AbortSignal;
}

/**
 * A pluggable lead source. Add a new one by dropping a file in src/sources/
 * that exports a LeadSource, then registering it in src/sources/index.ts.
 */
export interface LeadSource {
  id: string;
  name: string;
  /** Short note shown in the UI (e.g. "browser scraper, slower"). */
  note?: string;
  /** Whether this source can run live searches (avito is import-only → false). */
  enabled(): boolean;
  /** Yields leads for one (query, city). Must respect params.limit. */
  search(params: SearchParams): AsyncGenerator<Lead>;
  /**
   * Optional: report how many results are AVAILABLE for one (query, place)
   * without collecting them, using a cheap "count" request. Returns null when
   * the source can't report a count (e.g. Yandex). Used by the estimate feature.
   */
  count?(params: SearchParams): Promise<number | null>;
}

export type JobStatus = 'pending' | 'running' | 'done' | 'error' | 'cancelled';

export interface JobParams {
  sources: string[];
  queries: string[];
  /** Country/region/city targets (see Target). */
  targets: Target[];
  limitPerQuery: number;
  enrichEmail: boolean;
  /** Pause (ms) after each collected lead, to pace scraping. 0 = no delay. */
  delayMs: number;
}

export interface JobCounts {
  total: number;
  bySource: Record<string, number>;
  byCity: Record<string, number>;
  byCategory: Record<string, number>;
}

export interface Job {
  id: string;
  status: JobStatus;
  params: JobParams;
  createdAt: string;
  updatedAt: string;
  counts: JobCounts;
  error?: string;
}

/** Server-Sent-Event payloads streamed to the client during a job. */
export type JobEvent =
  | { type: 'progress'; done: number; total: number; counts: JobCounts }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'captcha'; message: string }
  | { type: 'lead'; lead: Lead }
  | { type: 'done'; counts: JobCounts }
  | { type: 'error'; message: string };
