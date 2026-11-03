import PQueue from 'p-queue';
import { http } from './http.js';
import { websiteDomain, primaryPhone } from './dedup.js';
import type { Lead } from './types.js';

/**
 * Optional website enricher. For a lead that has a website but is missing an
 * email and/or phone, it fetches ONLY that business's own site (homepage +
 * common contact pages) and extracts a public contact email and phone. This is
 * compliant: we read the business's own public website, not a third-party
 * directory — and it fills the gaps the map sources leave.
 */

// Dedicated, gentle queue so enrichment never floods a single small site.
const enrichQueue = new PQueue({ concurrency: 3, interval: 1000, intervalCap: 5 });

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Emails we never want (image/tracking/placeholder noise).
const JUNK_EMAIL = /(sentry|example\.|\.png|\.jpg|\.gif|\.webp|wixpress|@2x|u002)/i;

const CONTACT_PATHS = ['', '/contacts', '/contact', '/kontakty', '/about', '/o-kompanii'];

function pickBestEmail(candidates: string[], siteDomain?: string): string | undefined {
  const cleaned = candidates
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length <= 100 && !JUNK_EMAIL.test(e));
  if (cleaned.length === 0) return undefined;
  const unique = [...new Set(cleaned)];
  // Prefer an email on the business's own domain.
  if (siteDomain) {
    const own = unique.find((e) => e.split('@')[1]?.endsWith(siteDomain));
    if (own) return own;
  }
  // Otherwise prefer common business inbox prefixes.
  const preferred = unique.find((e) => /^(info|sales|office|mail|zakaz|order|opt)@/.test(e));
  return preferred ?? unique[0];
}

interface SiteContacts {
  email?: string;
  phone?: string;
}

async function fetchContactsFromSite(website: string, countryCode?: string): Promise<SiteContacts> {
  const domain = websiteDomain(website);
  if (!domain) return {};
  const base = /^https?:\/\//.test(website) ? website.replace(/\/+$/, '') : `https://${domain}`;

  const emails: string[] = [];
  const phones: string[] = [];

  for (const path of CONTACT_PATHS) {
    const url = base + path;
    try {
      const res = await http.get<string>(url, {
        responseType: 'text',
        timeout: 8000,
        maxRedirects: 3,
        headers: { Accept: 'text/html,application/xhtml+xml' },
      });
      if (typeof res.data !== 'string' || res.status >= 400) continue;

      // Emails: mailto: links are the strongest signal; also scan raw text.
      emails.push(...[...res.data.matchAll(/mailto:([^"'?>\s]+)/gi)].map((m) => m[1]));
      emails.push(...(res.data.match(EMAIL_RE) ?? []));

      // Phones: tel: links are reliable (the site's own click-to-call).
      for (const m of res.data.matchAll(/tel:([+\d()\s-]{7,})/gi)) {
        const norm = primaryPhone(m[1], countryCode);
        if (norm) phones.push(norm);
      }

      const email = pickBestEmail(emails, domain);
      const phone = phones[0];
      // Stop early only once we have BOTH (or exhausted paths).
      if (email && phone) return { email, phone };
    } catch {
      // ignore per-path failures (timeouts, 404s, TLS, etc.)
    }
  }
  return { email: pickBestEmail(emails, domain), phone: phones[0] };
}

/**
 * Enrich a lead (returns a new object). Fills a missing email and/or phone from
 * the business's own website. No-op if it has no website, or already has both.
 */
export async function enrichLead(lead: Lead, countryCode?: string): Promise<Lead> {
  if (!lead.website || (lead.email && lead.phone)) return lead;
  const found = await enrichQueue.add(() => fetchContactsFromSite(lead.website!, countryCode));
  if (!found) return lead;
  return {
    ...lead,
    email: lead.email ?? found.email,
    phone: lead.phone ?? found.phone,
  };
}
