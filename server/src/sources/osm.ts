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

/** bbox string in Overpass order: south, west, north, east. */
function bboxOf(params: SearchParams): string {
  const b = params.geo.bbox;
  return `(${b[0]},${b[1]},${b[2]},${b[3]})`;
}

/** Tag-based filter blocks (indexed → fast). Keyword-sensitive via KEYWORD_TAGS. */
function tagFilterBlocks(params: SearchParams): string[] {
  const bbox = bboxOf(params);
  const tagFilters = new Set<string>();
  for (const { match, filters } of KEYWORD_TAGS) {
    if (match.test(params.query)) filters.forEach((f) => tagFilters.add(f));
  }
  // Always include a couple of generic electronics/computer buckets.
  tagFilters.add('shop=computer');
  tagFilters.add('shop=electronics');

  const blocks: string[] = [];
  for (const f of tagFilters) {
    const [k, v] = f.split('=');
    blocks.push(`nwr["${k}"="${v}"]${bbox};`);
  }
  return blocks;
}

/** Name-regex blocks (unindexed → slow on big areas). Adds long-tail matches. */
function nameRegexBlocks(params: SearchParams): string[] {
  const bbox = bboxOf(params);
  // Escape the query for a case-insensitive OSM name regex.
  const safe = params.query.replace(/[\\"]/g, '\\$&');
  return [
    `nwr["name"~"${safe}",i]["shop"]${bbox};`,
    `nwr["name"~"${safe}",i]["office"]${bbox};`,
  ];
}

function buildQuery(params: SearchParams): string {
  // Full search: tag filters + name regex, capped generously above `limit`.
  const blocks = [...tagFilterBlocks(params), ...nameRegexBlocks(params)];
  const maxSize = Math.min(2000, Math.max(50, params.limit * 4));
  return `[out:json][timeout:60][maxsize:67108864];\n(\n${blocks.join('\n')}\n);\nout center tags ${maxSize};`;
}

/**
 * A COUNT query — tag filters only (no name regex), so it stays fast even over
 * large cities. Still keyword-sensitive via the keyword→tag mapping. May slightly
 * undercount vs. the full search (misses name-only matches); fine for an estimate.
 */
function buildCountQuery(params: SearchParams): string {
  return `[out:json][timeout:30];\n(\n${tagFilterBlocks(params).join('\n')}\n);\nout count;`;
}

/** Run an Overpass POST with backoff; returns parsed JSON (or empty on error). */
async function overpassRequest(
  body: string,
  params: SearchParams,
  timeoutMs = 70_000,
): Promise<{ elements?: OverpassElement[] }> {
  return withBackoff(
    () =>
      enqueue<{ elements?: OverpassElement[] }>(SOURCE_ID, async () => {
        const res = await http.post<{ elements?: OverpassElement[] }>(
          env.OVERPASS_URL,
          'data=' + encodeURIComponent(body),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: timeoutMs,
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
  async count(params: SearchParams): Promise<number | null> {
    // Short timeout: Overpass counts over big cities can be slow, and the
    // estimate must stay responsive. If it doesn't answer in time → null (n/a).
    const data = await overpassRequest(buildCountQuery(params), params, 8_000).catch(() => ({
      elements: [],
    }));
    // `out count` returns a single element whose tags.total holds the count.
    const el = data?.elements?.[0];
    const totalStr = el?.tags?.total;
    const total = totalStr != null ? Number(totalStr) : NaN;
    return Number.isFinite(total) ? total : null;
  },
  async *search(params: SearchParams): AsyncGenerator<Lead> {
    const data = await overpassRequest(buildQuery(params), params);

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
