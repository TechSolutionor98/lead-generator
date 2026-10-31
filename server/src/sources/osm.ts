import { http } from '../http.js';
import { env } from '../env.js';
import { enqueue, withBackoff, RetryableError, isRetryableStatus } from '../queue.js';
import { finalizeLead } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * OpenStreetMap via the Overpass API — FREE, no key, open data.
 *
 * This is the reliable backbone source. We resolve the city to a bounding box
 * (geo.ts), then query business objects whose tags match the search intent,
 * plus a name-regex fallback so arbitrary Russian queries still work.
 */

const SOURCE_ID = 'osm';

// Map common query keywords → concrete OSM tag filters. This dramatically
// improves recall for the hardware/IT niche grabatoz cares about.
const KEYWORD_TAGS: { match: RegExp; filters: string[] }[] = [
  { match: /компьютер|computer|пк\b/i, filters: ['shop=computer', 'craft=electronics_repair'] },
  { match: /ноутбук|laptop/i, filters: ['shop=computer'] },
  { match: /комплект|запчаст|компонент|детал/i, filters: ['shop=computer', 'shop=electronics'] },
  { match: /электрон|electronic/i, filters: ['shop=electronics'] },
  { match: /телефон|смартфон|mobile|сотов/i, filters: ['shop=mobile_phone'] },
  { match: /сервис|ремонт|service|repair/i, filters: ['craft=electronics_repair', 'shop=electronics'] },
  { match: /интегратор|it\b|айти|софт|software/i, filters: ['office=it', 'office=company'] },
  { match: /майнинг|mining|крипто/i, filters: ['shop=computer', 'shop=electronics'] },
  { match: /опт|wholesale|дистрибьютор|distrib/i, filters: ['shop=trade', 'office=company'] },
  { match: /офис|канцел|office|print|оргтехник/i, filters: ['shop=stationery', 'office=it'] },
];

function buildQuery(params: SearchParams): string {
  // bbox = south, west, north, east (Overpass order).
  const b = params.geo.bbox;
  const bbox = `(${b[0]},${b[1]},${b[2]},${b[3]})`;

  const tagFilters = new Set<string>();
  for (const { match, filters } of KEYWORD_TAGS) {
    if (match.test(params.query)) filters.forEach((f) => tagFilters.add(f));
  }
  // Always include a couple of generic electronics/computer buckets.
  tagFilters.add('shop=computer');
  tagFilters.add('shop=electronics');

  // Escape the query for a case-insensitive OSM name regex.
  const safe = params.query.replace(/[\\"]/g, '\\$&');

  const blocks: string[] = [];
  for (const f of tagFilters) {
    const [k, v] = f.split('=');
    blocks.push(`nwr["${k}"="${v}"]${bbox};`);
  }
  // Name-regex fallback: any business-ish object whose name matches the query.
  blocks.push(`nwr["name"~"${safe}",i]["shop"]${bbox};`);
  blocks.push(`nwr["name"~"${safe}",i]["office"]${bbox};`);

  // Cap the Overpass result set generously above `limit`; we trim client-side.
  const maxSize = Math.min(2000, Math.max(50, params.limit * 4));
  return `[out:json][timeout:60][maxsize:67108864];\n(\n${blocks.join('\n')}\n);\nout center tags ${maxSize};`;
}

interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

function tagAddress(tags: Record<string, string>): string | undefined {
  const parts = [
    tags['addr:city'],
    tags['addr:street'],
    tags['addr:housenumber'],
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : tags['addr:full'] || undefined;
}

function elementToLead(el: OverpassElement, city: string): Lead | undefined {
  const tags = el.tags ?? {};
  const name = tags['name'] || tags['name:ru'] || tags['official_name'];
  if (!name) return undefined;

  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;
  const category =
    tags['shop'] || tags['office'] || tags['craft'] || tags['amenity'] || undefined;

  return finalizeLead({
    source: SOURCE_ID,
    name,
    category,
    phone: tags['phone'] || tags['contact:phone'] || tags['contact:mobile'],
    email: tags['email'] || tags['contact:email'],
    website: tags['website'] || tags['contact:website'] || tags['url'],
    address: tagAddress(tags),
    city,
    lat,
    lng: lon,
    sourceUrl: `https://www.openstreetmap.org/${el.type}/${el.id}`,
    collectedAt: new Date().toISOString(),
  });
}

export const osmSource: LeadSource = {
  id: SOURCE_ID,
  name: 'OpenStreetMap (Overpass)',
  note: 'free · open data',
  enabled: () => true,
  async *search(params: SearchParams): AsyncGenerator<Lead> {
    const body = buildQuery(params);

    const data = await withBackoff(
      () =>
        enqueue<{ elements?: OverpassElement[] }>(SOURCE_ID, async () => {
          const res = await http.post<{ elements?: OverpassElement[] }>(
            env.OVERPASS_URL,
            'data=' + encodeURIComponent(body),
            {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              timeout: 70_000,
            },
          );
          if (isRetryableStatus(res.status)) {
            throw new RetryableError(`Overpass busy`, res.status);
          }
          if (res.status >= 400) {
            params.log?.(`[osm] Overpass returned ${res.status}`);
            return { elements: [] };
          }
          return res.data;
        }),
      { log: (m) => params.log?.(`[osm] ${m}`), signal: params.signal },
    );

    const elements = data?.elements ?? [];
    const seen = new Set<string>();
    let yielded = 0;
    for (const el of elements) {
      if (yielded >= params.limit) break;
      const lead = elementToLead(el, params.city);
      if (!lead) continue;
      // Light in-source dedup so a shop tagged twice isn't yielded twice.
      const key = (lead.name + '|' + (lead.address ?? '')).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      yielded += 1;
      yield lead;
    }
    params.log?.(`[osm] ${params.city} / "${params.query}" → ${yielded} leads`);
  },
};
