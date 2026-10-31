import type { BrowserContext, Page } from 'playwright';
import { newContext } from '../browser.js';
import { env } from '../env.js';
import { finalizeLead } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * Yandex Maps — FREE, via a Playwright headless browser over maps.yandex.ru.
 *
 * Strategy (robust against Yandex's shifting markup):
 *   1. Load the search, scroll the results list to lazy-load business snippets.
 *   2. Read name / category / address / rating + the org link straight from
 *      each snippet in the list (no per-card navigation needed for these).
 *   3. For each org, open its card page to read phone + website.
 *
 * Selectors are centralized in SEL so they are easy to repair. On SmartCaptcha
 * we emit a `captcha` log and stop that query — we never auto-solve.
 */

// These run inside the browser via page.evaluate, where DOM globals exist but
// the Node tsconfig has no DOM lib. Declare them loosely for type-checking.
declare const document: any;

const SOURCE_ID = 'yandex';

// --- Centralized selectors (repair here if Yandex changes its markup) -------
const SEL = {
  resultsList: '.search-list-view__list, .scroll__container',
  snippet: '.search-business-snippet-view',
  snippetName: '.search-business-snippet-view__title',
  snippetCategory: '.search-business-snippet-view__category',
  snippetAddress: '.search-business-snippet-view__address',
  snippetRating: '[class*="business-rating-badge"], [class*="rating"]',
  snippetLink: 'a[href*="/maps/org/"]',
  captcha: 'form#checkbox-captcha-form, [class*="SmartCaptcha"], [class*="CheckboxCaptcha"]',
  // Card (opened org) selectors.
  cardTitle: '[class*="card-title-view__title"]',
  cardPhones: '[class*="card-phones-view"]',
  cardUrls: '[class*="business-urls-view"]',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

async function hasCaptcha(page: Page): Promise<boolean> {
  try {
    return (await page.locator(SEL.captcha).count()) > 0;
  } catch {
    return false;
  }
}

/** Snippet data read directly from the list (no navigation). */
interface Snippet {
  name?: string;
  category?: string;
  address?: string;
  ratingText?: string;
  href?: string;
}

async function readSnippets(page: Page): Promise<Snippet[]> {
  // NB: the callback is serialized to the browser. Do NOT declare inner named
  // functions here — tsx/esbuild rewrites them with a `__name` helper that is
  // undefined in page context. Keep everything inline.
  return page.locator(SEL.snippet).evaluateAll(
    (nodes: any[], sel: Record<string, string>) =>
      nodes.map((el: any) => {
        const nameN = el.querySelector(sel.snippetName);
        const catN = el.querySelector(sel.snippetCategory);
        const addrN = el.querySelector(sel.snippetAddress);
        const ratN = el.querySelector(sel.snippetRating);
        const link = el.querySelector(sel.snippetLink);
        return {
          name: nameN && nameN.textContent ? nameN.textContent.trim() : undefined,
          category: catN && catN.textContent ? catN.textContent.trim() : undefined,
          address: addrN && addrN.textContent ? addrN.textContent.trim() : undefined,
          ratingText: ratN && ratN.textContent ? ratN.textContent.trim() : undefined,
          href: link ? link.getAttribute('href') || undefined : undefined,
        };
      }),
    SEL,
  );
}

/** Phone + website read from an opened org card page. */
async function readCard(page: Page): Promise<{ phone?: string; website?: string }> {
  return page.evaluate((sel) => {
    const out: { phone?: string; website?: string } = {};
    const phoneEl = document.querySelector(sel.cardPhones);
    if (phoneEl && phoneEl.textContent) {
      const m = phoneEl.textContent.match(/\+?\d[\d\s()\-]{8,}\d/);
      if (m) out.phone = m[0];
    }
    // Website: prefer an external (non-yandex) link in the urls block, else its text.
    const urlsBlock = document.querySelector(sel.cardUrls);
    if (urlsBlock) {
      const a = urlsBlock.querySelector('a[href^="http"]') as { getAttribute(n: string): string | null } | null;
      const href = a?.getAttribute('href');
      if (href && !/yandex\./.test(href)) out.website = href;
      else if (urlsBlock.textContent) out.website = urlsBlock.textContent.trim();
    }
    return out;
  }, SEL);
}

function parseRating(text?: string): { rating?: number; reviews?: number } {
  if (!text) return {};
  const r = text.match(/(\d+)[.,](\d)/);
  const rev = text.match(/(\d[\d\s]*)\s*(?:оцен|отзыв)/i);
  return {
    rating: r ? parseFloat(`${r[1]}.${r[2]}`) : undefined,
    reviews: rev ? parseInt(rev[1].replace(/\s/g, ''), 10) || undefined : undefined,
  };
}

/** Strip tracking params from a Yandex-provided website URL. */
function cleanWebsite(raw?: string): string | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (!s) return undefined;
  try {
    const u = new URL(/^https?:\/\//.test(s) ? s : `https://${s}`);
    return `${u.protocol}//${u.host}${u.pathname === '/' ? '' : u.pathname}`;
  } catch {
    return s;
  }
}

async function scrollResults(page: Page, want: number, log?: (m: string) => void): Promise<void> {
  const container = page.locator(SEL.resultsList).first();
  let last = 0;
  let stale = 0;
  for (let i = 0; i < 40 && stale < 4; i++) {
    const count = await page.locator(SEL.snippet).count();
    if (count >= want) break;
    stale = count === last ? stale + 1 : 0;
    last = count;
    try {
      await container.evaluate((el) => el.scrollBy(0, el.scrollHeight));
    } catch {
      await page.mouse.wheel(0, 1400);
    }
    await sleep(jitter(650, 1200));
  }
  log?.(`[yandex] loaded ${await page.locator(SEL.snippet).count()} snippets`);
}

export const yandexSource: LeadSource = {
  id: SOURCE_ID,
  name: 'Yandex Maps',
  note: 'browser scraper · slower · may hit captcha',
  enabled: () => true,
  async *search(params: SearchParams): AsyncGenerator<Lead> {
    let context: BrowserContext | undefined;
    let yielded = 0;
    try {
      context = await newContext();
      const page = await context.newPage();
      const text = `${params.query} ${params.city}`.trim();
      const url = `https://yandex.ru/maps/?text=${encodeURIComponent(text)}&l=map`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(jitter(2500, 4000));

      if (await hasCaptcha(page)) {
        params.log?.('[yandex] SmartCaptcha detected — not auto-solving.');
        if (!env.YANDEX_HEADLESS) {
          params.log?.('[yandex] solve the captcha in the open window (waiting up to 120s)…');
          try {
            await page.waitForSelector(SEL.captcha, { state: 'detached', timeout: 120_000 });
          } catch {
            params.log?.('[yandex] captcha not solved in time, skipping query.');
            return;
          }
        } else {
          params.log?.('[yandex] set YANDEX_HEADLESS=false to solve it manually, skipping query.');
          return;
        }
      }

      try {
        await page.waitForSelector(SEL.snippet, { timeout: 15_000 });
      } catch {
        params.log?.(`[yandex] no results for "${text}"`);
        return;
      }

      await scrollResults(page, params.limit, params.log);

      // Read basic fields for every snippet up-front (the list is stable here).
      const snippets = (await readSnippets(page))
        .filter((s) => s.name && s.href)
        .filter((s, i, arr) => arr.findIndex((x) => x.href === s.href) === i) // dedupe by href
        .slice(0, params.limit);

      if (snippets.length === 0) {
        params.log?.('[yandex] could not read snippets (layout may have changed)');
        return;
      }

      for (const s of snippets) {
        if (params.signal?.aborted || yielded >= params.limit) break;
        const { rating, reviews } = parseRating(s.ratingText);
        const orgUrl = 'https://yandex.ru' + s.href!.replace(/\/(gallery|reviews|photos)\/?$/, '/');

        // Open the org card to get phone + website.
        let phone: string | undefined;
        let website: string | undefined;
        try {
          await page.goto(orgUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          await sleep(jitter(900, 1700));
          if (await hasCaptcha(page)) {
            params.log?.('[yandex] captcha mid-run — stopping query.');
            break;
          }
          const card = await readCard(page);
          phone = card.phone;
          website = cleanWebsite(card.website);
        } catch (err) {
          params.log?.(`[yandex] card failed (${s.name}): ${(err as Error).message}`);
        }

        yielded += 1;
        yield finalizeLead({
          source: SOURCE_ID,
          name: s.name!,
          category: s.category,
          phone,
          website,
          address: s.address,
          city: params.city,
          rating,
          reviewsCount: reviews,
          sourceUrl: orgUrl,
          collectedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      params.log?.(`[yandex] error: ${(err as Error).message}`);
    } finally {
      await context?.close().catch(() => undefined);
      params.log?.(`[yandex] ${params.city} / "${params.query}" → ${yielded} leads`);
    }
  },
};
