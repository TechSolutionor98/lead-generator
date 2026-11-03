import type { LeadSource } from '../types.js';
import { osmSource } from './osm.js';
import { twogisSource } from './twogis.js';
import { yandexSource } from './yandex.js';
import { googleSource } from './google.js';
import { bingSource, googleSearchSource } from './websearch.js';
import { avitoSource } from './avito.js';

/**
 * Source registry.
 *
 * To add a new source: create src/sources/<id>.ts exporting a `LeadSource`,
 * then import it here and add it to the array below. Nothing else needs to
 * change — the job runner, API, and UI discover it automatically.
 */
const ALL: LeadSource[] = [
  osmSource,
  twogisSource,
  yandexSource,
  googleSource,
  bingSource,
  googleSearchSource,
  avitoSource,
];

export const sources = new Map<string, LeadSource>(ALL.map((s) => [s.id, s]));

export function getSource(id: string): LeadSource | undefined {
  return sources.get(id);
}

/** Public descriptor list for the frontend (GET /api/sources). */
export function sourceList(): {
  id: string;
  name: string;
  note?: string;
  enabled: boolean;
}[] {
  return ALL.map((s) => ({ id: s.id, name: s.name, note: s.note, enabled: s.enabled() }));
}
