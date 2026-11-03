import type { BrowserContext, Page } from 'playwright';
import { newContext } from '../browser.js';
import { finalizeLead } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * Google Maps — FREE, via a Playwright headless browser over google.com/maps.
 *
 * Strategy (robust against Google's obfuscated markup):
 *   1. Load the search, dismiss any consent prompt.
 *   2. Scroll the results feed to lazy-load business cards.
 *   3. Read name / category / address / rating / PHONE straight from each feed
 *      card — Google puts the phone in the card text, so no per-place nav needed.
 *
 * Anchors on the stable place link (a[href*="/maps/place/"]) and aria-label,
 * not obfuscated class names. On a Google "unusual traffic" page we stop the
 * query gracefully — we never auto-solve captchas.
 */

// Runs inside the browser via page.evaluate; declare DOM globals loosely.
declare const document: any;

const SOURCE_ID = 'google';

const SEL = {
  feed: '[role="feed"]',
  placeLink: 'a[href*="/maps/place/"]',
  consent:
    'button[aria-label*="Accept all"], button[aria-label*="Reject all"], button[aria-label*="Принять все"], button[aria-label*="Отклонить все"], form[action*="consent"] button',
  sorry: 'form#captcha-form, [action*="/sorry/"]',
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jitter = (min: number, max: number) => min + Math.floor(Math.random() * (max - min));

/** Google sometimes shows a consent interstitial; dismiss it if present. */
async function dismissConsent(page: Page): Promise<void> {
  try {
    const btn = page.locator(SEL.consent).first();
    if ((await btn.count()) > 0) {
      await btn.click({ timeout: 4000 }).catch(() => undefined);
      await sleep(jitter(1200, 2200));
    }
  } catch {
    /* ignore */
  }
}

async function onSorryPage(page: Page): Promise<boolean> {
  if (/\/sorry\//.test(page.url())) return true;
  try {
    return (await page.locator(SEL.sorry).count()) > 0;
  } catch {
    return false;
  }
}

interface Snippet {
  name?: string;
  category?: string;
  address?: string;
  phone?: string;
  rating?: number;
  reviews?: number;
  href?: string;
}

async function readCards(page: Page): Promise<Snippet[]> {
  // Keep everything inline (no inner named functions — tsx/esbuild would add a
  // `__name` helper that doesn't exist in the page context).
  return page.evaluate((sel: Record<string, string>) => {
    const feed = document.querySelector(sel.feed);
    const arts = feed ? Array.from(feed.children) : [];
    const out: any[] = [];
    for (const art of arts as any[]) {
      const link = art.querySelector ? art.querySelector(sel.placeLink) : null;
      if (!link) continue;
      const name = (link.getAttribute('aria-label') || '').trim();
      if (!name) continue;
      const href = link.getAttribute('href') || undefined;
      const text = (art.textContent || '').replace(/\s+/g, ' ').trim();

      const phoneM = text.match(/(?:\+?7|8)[\d\s()\-]{9,}\d/);
      const ratM = text.match(/(\d+[.,]\d+)\s*\(([\d\s ]+)\)/);

      // category + address from the obfuscated info spans, with a text fallback.
      let category: string | undefined;
      let address: string | undefined;
      const infos = Array.from(art.querySelectorAll('.W4Efsd') as any[])
        .map((e: any) => (e.textContent || '').trim())
        .filter(Boolean);
      for (const line of infos) {
        if (line.indexOf('·') < 0) continue;
        const parts = line
          .split('·')
          .map((s: string) => s.trim())
          .filter((p: string) => p && !/^\$+$/.test(p));
        if (!parts.length) continue;
        if (!category) category = parts[0];
        let addr = parts
          .slice(1)
          .find((p: string) => /\d|ул|пер|просп|пр-т|ш\.|бул|наб|пл\.|д\./i.test(p));
        if (addr) {
          // The info span glues phone + opening-hours onto the address; strip them.
          addr = addr
            .replace(/(?:\+?7|8)[\d\s()\-]{7,}\d.*$/, '')
            .replace(/(Закрыт|Открыт|Откроется|Скоро закро|Круглосуточно|Временно|Ещё\b).*$/i, '')
            .trim()
            .replace(/[·,\s]+$/, '');
          if (addr && !address) address = addr;
        }
      }

      out.push({
        name,
        category,
        address,
        phone: phoneM ? phoneM[0] : undefined,
        rating: ratM ? parseFloat(ratM[1].replace(',', '.')) : undefined,
        reviews: ratM ? parseInt(ratM[2].replace(/[\s ]/g, ''), 10) || undefined : undefined,
        href,
      });
    }
    return out;
  }, SEL);
}

async function scrollFeed(page: Page, want: number, log?: (m: string) => void): Promise<void> {
  const feed = page.locator(SEL.feed).first();
  let last = 0;
  let stale = 0;
  for (let i = 0; i < 40 && stale < 4; i++) {
    const count = await page.locator(`${SEL.feed} ${SEL.placeLink}`).count();
    if (count >= want) break;
    stale = count === last ? stale + 1 : 0;
    last = count;
    try {
      await feed.evaluate((el: any) => el.scrollBy(0, el.scrollHeight));
    } catch {
      await page.mouse.wheel(0, 1400);
    }
    await sleep(jitter(700, 1300));
  }
  log?.(`[google] loaded ${await page.locator(`${SEL.feed} ${SEL.placeLink}`).count()} cards`);
}

export const googleSource: LeadSource = {
  id: SOURCE_ID,
  name: 'Google Maps',
  note: 'browser scraper · slower · may hit captcha',
  enabled: () => true,
  async *search(params: SearchParams): AsyncGenerator<Lead> {
    let context: BrowserContext | undefined;
    let yielded = 0;
    try {
      context = await newContext();
      const page = await context.newPage();
      const text = `${params.query} ${params.city}`.trim();
      const url = `https://www.google.com/maps/search/${encodeURIComponent(text)}/?hl=ru`;
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await sleep(jitter(2500, 4000));

      await dismissConsent(page);

      if (await onSorryPage(page)) {
        params.log?.('[google] hit an "unusual traffic" page — not auto-solving, skipping query.');
        return;
      }

      try {
        await page.waitForSelector(SEL.feed, { timeout: 15_000 });
      } catch {
        params.log?.(`[google] no results feed for "${text}"`);
        return;
      }

      await scrollFeed(page, params.limit, params.log);

      const cards = (await readCards(page))
        .filter((c) => c.name)
        .filter((c, i, arr) => !c.href || arr.findIndex((x) => x.href === c.href) === i)
        .slice(0, params.limit);

      if (cards.length === 0) {
        params.log?.('[google] could not read cards (layout may have changed)');
        return;
      }

      for (const c of cards) {
        if (params.signal?.aborted || yielded >= params.limit) break;
        yielded += 1;
        yield finalizeLead({
          source: SOURCE_ID,
          name: c.name!,
          category: c.category,
          phone: c.phone,
          address: c.address,
          city: params.city,
          rating: c.rating,
          reviewsCount: c.reviews,
          sourceUrl: c.href ? (c.href.startsWith('http') ? c.href : `https://www.google.com${c.href}`) : undefined,
          collectedAt: new Date().toISOString(),
        });
      }
    } catch (err) {
      params.log?.(`[google] error: ${(err as Error).message}`);
    } finally {
      await context?.close().catch(() => undefined);
      params.log?.(`[google] ${params.city} / "${params.query}" → ${yielded} leads`);
    }
  },
};
