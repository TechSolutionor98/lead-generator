import type { Lead } from './types.js';

/**
 * Normalize a Russian phone number to E.164 (+7XXXXXXXXXX).
 *
 * - Strips spaces, dashes, parentheses, dots.
 * - A leading domestic trunk "8" becomes country code "7".
 * - Accepts input with or without a leading "+".
 * - Returns undefined when the result is not a plausible 11-digit RU number
 *   (country code 7 + 10 national digits).
 */
export function normalizePhone(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  // Keep only digits (drop +, spaces, punctuation, letters).
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return undefined;

  // Domestic "8XXXXXXXXXX" → "7XXXXXXXXXX".
  if (digits.length === 11 && digits.startsWith('8')) {
    digits = '7' + digits.slice(1);
  }
  // Bare 10-digit national number → prefix country code 7.
  if (digits.length === 10) {
    digits = '7' + digits;
  }

  // Must be an 11-digit Russian number starting with 7.
  if (digits.length !== 11 || !digits.startsWith('7')) return undefined;

  return '+' + digits;
}

/**
 * Format the FIRST phone found in a free-text string (some sources return
 * several joined by commas). Returns the normalized primary number.
 */
export function primaryPhone(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/[,;/]+/)[0];
  return normalizePhone(first);
}

/** Lowercased registrable host of a URL, without "www." or path. */
export function websiteDomain(raw?: string | null): string | undefined {
  if (!raw) return undefined;
  let s = raw.trim().toLowerCase();
  if (!s) return undefined;
  if (!/^https?:\/\//.test(s)) s = 'http://' + s;
  try {
    const host = new URL(s).hostname.replace(/^www\./, '');
    return host || undefined;
  } catch {
    return undefined;
  }
}

/** Collapse any text to a comparable slug (lowercase alnum incl. Cyrillic). */
export function slug(raw?: string | null): string {
  if (!raw) return '';
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9Ѐ-ӿ]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * The deduplication key for a lead. Precedence:
 *   1. normalized phone
 *   2. website domain
 *   3. slug(name) + "|" + slug(address)
 * This matches the spec: dedup by phone OR website domain OR name+address.
 */
export function dedupKey(lead: Lead): string {
  const phone = primaryPhone(lead.phone);
  if (phone) return 'tel:' + phone;

  const domain = websiteDomain(lead.website);
  if (domain) return 'web:' + domain;

  return 'na:' + slug(lead.name) + '|' + slug(lead.address);
}

// Organization markers — if any appears as a substring, the lead is a business.
// NB: JS \b word boundaries are ASCII-only and do not work around Cyrillic, so
// we match substrings (case-insensitive). This biases toward "business", which
// is the safe direction for a 152-FZ exclude toggle.
const ORG_MARKERS =
  /(ооо|оао|зао|пао|нко|тоо|магазин|сервис|центр|компани|групп|маркет|торг|опт|студи|салон|мастерск|завод|фабрик|сеть|group|store|shop|market|ltd|llc|\binc\b|\bco\b)/i;

// A bare Russian personal name: "Иван Петров" / "Петров Иван Сергеевич".
const PERSONAL_NAME =
  /^[А-ЯЁ][а-яё]+(?:\s+[А-ЯЁ][а-яё]+){1,2}$/;

/**
 * Heuristic: does this lead look like an individual / sole trader rather than
 * a company? Used by the UI "exclude individuals" toggle (152-FZ friendly).
 */
export function isIndividual(lead: Lead): boolean {
  const name = (lead.name || '').trim();
  if (!name) return false;
  // Explicit ИП prefix is a sole trader (a person's data under 152-FZ).
  if (/^\s*ип[\s.]/i.test(name)) return true;
  // Any organizational marker → treat as a business.
  if (ORG_MARKERS.test(name)) return false;
  // Looks like just a person's full name → individual.
  return PERSONAL_NAME.test(name);
}

/** Apply normalization + isIndividual tagging to a freshly-collected lead. */
export function finalizeLead(lead: Lead): Lead {
  const phone = primaryPhone(lead.phone) ?? lead.phone;
  const out: Lead = { ...lead, phone };
  out.isIndividual = isIndividual(out);
  return out;
}
