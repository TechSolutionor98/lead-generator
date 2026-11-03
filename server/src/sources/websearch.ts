import type { BrowserContext, Page } from 'playwright';
import { newContext } from '../browser.js';
import { finalizeLead } from '../dedup.js';
import { websiteDomain } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * Web-search lead sources (Bing + Google web search).
 *
 * These discover business WEBSITES from organic search results (title + URL).
 * They carry no phone/address themselves — the website email-enricher (enabled
 * per job) then fetches each business's own site for a phone + email. So these
 * are best run with "Enrich email + phone" on.
 *
 * Compliance: scraping search engines is against their ToS; used here for the
 * operator's own lead research. We NEVER solve captchas — if an engine shows a
 * block/consent page we stop that query gracefully.
 *
 * Bing is scrapable directly. Google web search blocks datacenter IPs with a
 * /sorry captcha; its source attempts and skips unless a residential PROXY_URL
 * lets it through.
 */

declare const document: any;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

// Directories, aggregators, social, marketplaces, maps — not individual
// business sites, so we skip them (the enricher can't turn these into a lead).
const NOISE_DOMAIN =
  /(^|\.)(bing|google|yandex|go\.mail|rambler|duckduckgo|2gis|zoon|yell|jsprav|spravka|flamp|otzovik|irecommend|prodoctorov|wikipedia|wikimedia|youtube|youtu\.be|vk|ok\.ru|facebook|instagram|twitter|t\.me|telegram|pinterest|livejournal|dzen|avito|ozon|wildberries|market\.yandex|aliexpress|tiu\.ru|pulscen|blizko|regmarkets|satom|allbiz)\./i;

function cleanTitle(t: string): string {
  return t
    .replace(/\s*[|·—–-]\s*(bing|google|поиск|search).*$/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 140);
}

/** Make a website lead from a search hit, or undefined if it's noise. */
function hitToLead(sourceId: string, title: string, url: string, city: string): Lead | undefined {
  const domain = websiteDomain(url);
  if (!domain || NOISE_DOMAIN.test(domain)) return undefined;
  const name = cleanTitle(title);
  if (!name) return undefined;
  return finalizeLead({
    source: sourceId,
    name,
    website: url,
    city,
    sourceUrl: url,
    collectedAt: new Date().toISOString(),
  });
}

/** Detect a block / captcha / consent interstitial. */
function isBlocked(page: Page): boolean {
  const u = page.url();
  return /\/sorry\/|captcha|consent\.|\/challenge/i.test(u);
}

// --- Bing -------------------------------------------------------------------

/** Read Bing organic results, decoding its /ck/a redirect links to real URLs. */
async function readBing(page: Page): Promise<{ title: string; url: string }[]> {
  return page.evaluate(() => {
    const out: { title: string; url: string }[] = [];
    const items = Array.from(document.querySelectorAll('li.b_algo')) as any[];
    for (const li of items) {
      const a = li.querySelector('h2 a');
      if (!a) continue;
      const title = (a.textContent || '').trim();
      let url = a.getAttribute('href') || '';
      // Bing wraps the target in /ck/a?...&u=a1<base64url>.
      try {
        const parsed = new URL(url, 'https://www.bing.com');
        if (/bing\.com$/.test(parsed.hostname) && parsed.pathname.indexOf('/ck/') === 0) {
          const uParam = parsed.searchParams.get('u') || '';
          if (uParam.indexOf('a1') === 0) {
            let b64 = uParam.slice(2).replace(/-/g, '+').replace(/_/g, '/');
            while (b64.length % 4) b64 += '=';
            url = decodeURIComponent(escape(atob(b64)));
          }
        }
      } catch {
        /* keep original url */
      }
      if (title && /^https?:\/\//.test(url)) out.push({ title, url });
    }
    return out;
  });
}

// --- Google web search ------------------------------------------------------

async function readGoogle(page: Page): Promise<{ title: string; url: string }[]> {
  return page.evaluate(() => {
    const out: { title: string; url: string }[] = [];
    const blocks = Array.from(document.querySelectorAll('div.g, div.tF2Cxc, div.MjjYud')) as any[];
    for (const g of blocks) {
      const a = g.querySelector('a[href^="http"]');
      const h3 = g.querySelector('h3');
      if (!a || !h3) continue;
      const title = (h3.textContent || '').trim();
      const url = a.getAttribute('href') || '';
      if (title && /^https?:\/\//.test(url)) out.push({ title, url });
    }
    return out;
  });
}

interface EngineConfig {
  id: string;
  name: string;
  pageUrl: (query: string, first: number) => string;
  read: (page: Page) => Promise<{ title: string; url: string }[]>;
  pageStep: number; // index increment per page
  maxPages: number;
}

function makeWebSearchSource(cfg: EngineConfig): LeadSource {
  return {
    id: cfg.id,
    name: cfg.name,
    note: 'web search → website · enrich for phone/email',
    enabled: () => true,
    async *search(params: SearchParams): AsyncGenerator<Lead> {
      let context: BrowserContext | undefined;
      let yielded = 0;
      const seenDomains = new Set<string>();
      try {
        context = await newContext();
        const page = await context.newPage();
        const query = `${params.query} ${params.city}`.trim();

        for (let p = 0; p < cfg.maxPages && yielded < params.limit; p++) {
          if (params.signal?.aborted) break;
          const first = 1 + p * cfg.pageStep;
          await page.goto(cfg.pageUrl(query, first), {
            waitUntil: 'domcontentloaded',
            timeout: 40_000,
          });
          await sleep(jitter(1500, 2800));

          if (isBlocked(page)) {
            params.log?.(
              `[${cfg.id}] blocked by a captcha/consent page — skipping (set a residential PROXY_URL to use this source).`,
            );
            break;
          }

          const hits = await cfg.read(page);
          if (hits.length === 0) {
            params.log?.(`[${cfg.id}] no results on page ${p + 1} for "${query}"`);
            break;
          }

          let newOnPage = 0;
          for (const h of hits) {
            if (yielded >= params.limit) break;
            const lead = hitToLead(cfg.id, h.title, h.url, params.city);
            if (!lead || !lead.website) continue;
            const dom = websiteDomain(lead.website) || lead.website;
            if (seenDomains.has(dom)) continue;
            seenDomains.add(dom);
            newOnPage++;
            yielded += 1;
            yield lead;
          }
          // Stop paginating once a page yields nothing new.
          if (newOnPage === 0) break;
        }
      } catch (err) {
        params.log?.(`[${cfg.id}] error: ${(err as Error).message}`);
      } finally {
        await context?.close().catch(() => undefined);
        params.log?.(`[${cfg.id}] ${params.city} / "${params.query}" → ${yielded} leads`);
      }
    },
  };
}

export const bingSource = makeWebSearchSource({
  id: 'bing',
  name: 'Bing Search',
  pageUrl: (q, first) =>
    `https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=ru&first=${first}`,
  read: readBing,
  pageStep: 10,
  maxPages: 5,
});

export const googleSearchSource = makeWebSearchSource({
  id: 'google_search',
  name: 'Google Search',
  pageUrl: (q, first) =>
    `https://www.google.com/search?q=${encodeURIComponent(q)}&hl=ru&num=20&start=${first - 1}`,
  read: readGoogle,
  pageStep: 20,
  maxPages: 3,
});
