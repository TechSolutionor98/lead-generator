// Mirrors server/src/types.ts (the fields the UI consumes).

export interface Lead {
  id?: string;
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
  collectedAt: string;
  isIndividual?: boolean;
}

export interface SourceInfo {
  id: string;
  name: string;
  note?: string;
  enabled: boolean;
}

/**
 * One search target, broad → narrow:
 *   country only → whole country; +region → whole region; +city → that city.
 */
export interface Target {
  country: string;
  countryCode: string; // ISO 3166-1 alpha-2
  region?: string;
  city?: string;
}

/** A selectable country. */
export interface Country {
  name: string;
  code: string; // ISO 3166-1 alpha-2
}

/** A region or city option: display name + a code used for the next lookup. */
export interface NamedCode {
  name: string;
  code: string;
}

export interface JobCounts {
  total: number;
  bySource: Record<string, number>;
  byCity: Record<string, number>;
  byCategory: Record<string, number>;
}

export type JobEvent =
  | { type: 'progress'; done: number; total: number; counts: JobCounts }
  | { type: 'log'; level: 'info' | 'warn' | 'error' | 'captcha'; message: string }
  | { type: 'lead'; lead: Lead }
  | { type: 'done'; counts: JobCounts }
  | { type: 'error'; message: string };

export interface LeadsResponse {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  leads: Lead[];
}
