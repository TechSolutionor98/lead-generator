import { http } from '../http.js';
import { env } from '../env.js';
import { enqueue, withBackoff, RetryableError, isRetryableStatus } from '../queue.js';
import type { AxiosResponse } from 'axios';
import { finalizeLead } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * 2GIS — FREE, via the public catalog web endpoint that 2gis.ru itself calls.
 *
 * Endpoint: https://catalog.api.2gis.ru/3.0/items
 * Auth:     `key` = the public web key embedded in the 2GIS site (env.TWOGIS_WEB_KEY).
 * This returns full business data including phones + websites at no cost.
 *
 * Note: this is scraping of an undocumented public endpoint — against 2GIS ToS,
 * used here for the operator's own lead research. No captcha / browser needed.
 */

const SOURCE_ID = 'twogis';
const endpoint = () => `https://${env.TWOGIS_API_HOST}/3.0/items`;
const PAGE_SIZE = 50; // max allowed by the endpoint

interface Contact {
  type?: string; // "phone" | "email" | "website" | "general" | ...
  value?: string;
  text?: string;
  url?: string;
}
interface ContactGroup {
  contacts?: Contact[];
}
interface Rubric {
  name?: string;
}
interface TwoGisItem {
  id?: string;
  name?: string;
  full_name?: string;
  full_address_name?: string;
  address_name?: string;
  point?: { lat?: number; lon?: number };
  rubrics?: Rubric[];
  contact_groups?: ContactGroup[];
  reviews?: { rating?: number; review_count?: number };
}
interface TwoGisResponse {
  meta?: { code?: number; error?: { message?: string } };
  result?: { total?: number; items?: TwoGisItem[] };
}

function extractContacts(item: TwoGisItem): {
  phone?: string;
  email?: string;
  website?: string;
} {
  const out: { phone?: string; email?: string; website?: string } = {};
  for (const group of item.contact_groups ?? []) {
    for (const c of group.contacts ?? []) {
      const type = (c.type ?? '').toLowerCase();
      const value = c.value ?? c.text ?? c.url;
      if (!value) continue;
      if (type === 'phone' && !out.phone) out.phone = value;
      else if (type === 'email' && !out.email) out.email = value;
      else if ((type === 'website' || type === 'url') && !out.website) {
        out.website = c.url ?? value;
      }
    }
  }
  return out;
}

function itemToLead(item: TwoGisItem, city: string, countryCode: string): Lead | undefined {
  const name = item.name || item.full_name;
  if (!name) return undefined;
  const { phone, email, website } = extractContacts(item);
  return finalizeLead(
    {
      source: SOURCE_ID,
      name,
      category: item.rubrics?.[0]?.name,
      phone,
      email,
      website,
      address: item.full_address_name || item.address_name,
      city,
      lat: item.point?.lat,
      lng: item.point?.lon,
      rating: item.reviews?.rating,
      reviewsCount: item.reviews?.review_count,
      sourceUrl: item.id ? `https://2gis.ru/firm/${item.id.split('_')[0]}` : undefined,
      collectedAt: new Date().toISOString(),
    },
    countryCode,
  );
}

export const twogisSource: LeadSource = {
  id: SOURCE_ID,
  name: '2GIS',
  note: 'names + addresses only (contacts are paid)',
  enabled: () => Boolean(env.TWOGIS_WEB_KEY),
  async count(params: SearchParams): Promise<number | null> {
    if (!env.TWOGIS_WEB_KEY) return null;
    const center = params.geo.center;
    const data = await withBackoff(
      () =>
        enqueue<AxiosResponse<TwoGisResponse>>(SOURCE_ID, async () => {
          const res = await http.get<TwoGisResponse>(endpoint(), {
            params: {
              q: `${params.query} ${params.city}`.trim(),
              location: `${center[0]},${center[1]}`,
              page: 1,
              page_size: 1, // we only need result.total, not the items
              fields: 'items.point',
              key: env.TWOGIS_WEB_KEY,
            },
          });
          if (isRetryableStatus(res.status)) {
            throw new RetryableError('2GIS throttled', res.status);
          }
          return res;
        }),
      { log: (m) => params.log?.(`[2gis] ${m}`), signal: params.signal },
    );
    const code = data.data.meta?.code;
    if (data.status >= 400 || (code && code >= 400)) return null;
    const total = data.data.result?.total;
    return typeof total === 'number' ? total : null;
  },
  async *search(params: SearchParams): AsyncGenerator<Lead> {
    if (!env.TWOGIS_WEB_KEY) {
      params.log?.('[2gis] no TWOGIS_WEB_KEY set — skipping (get a free demo key, see README)');
      return;
    }
    const center = params.geo.center;
    let page = 1;
    let yielded = 0;
    let total = Infinity;

    while (yielded < params.limit && (page - 1) * PAGE_SIZE < total) {
      if (params.signal?.aborted) break;
      const currentPage = page;

      const data = await withBackoff(
        () =>
          enqueue<AxiosResponse<TwoGisResponse>>(SOURCE_ID, async () => {
            const res = await http.get<TwoGisResponse>(endpoint(), {
              params: {
                q: `${params.query} ${params.city}`.trim(),
                location: `${center[0]},${center[1]}`,
                page: currentPage,
                page_size: PAGE_SIZE,
                fields:
                  'items.point,items.contact_groups,items.rubrics,items.reviews,items.address,items.full_address_name',
                key: env.TWOGIS_WEB_KEY,
              },
            });
            if (isRetryableStatus(res.status)) {
              throw new RetryableError('2GIS throttled', res.status);
            }
            return res;
          }),
        { log: (m) => params.log?.(`[2gis] ${m}`), signal: params.signal },
      );

      const code = data.data.meta?.code;
      if (data.status >= 400 || (code && code >= 400)) {
        const msg = data.data.meta?.error?.message || `HTTP ${data.status}`;
        params.log?.(`[2gis] stopped: ${msg} (the public web key may be rotated — set TWOGIS_WEB_KEY)`);
        break;
      }

      const items = data.data.result?.items ?? [];
      total = data.data.result?.total ?? items.length;
      if (items.length === 0) break;

      for (const item of items) {
        if (yielded >= params.limit) break;
        const lead = itemToLead(item, params.city, params.countryCode);
        if (!lead) continue;
        yielded += 1;
        yield lead;
      }
      page += 1;
    }
    params.log?.(`[2gis] ${params.city} / "${params.query}" → ${yielded} leads`);
  },
};
