import type { Lead } from './types.js';
import { countryMeta } from './country.js';

/**
 * Normalize a phone number to E.164 (+<country><national>) for a given country.
 *
 * Country-aware (defaults to Russia when no country is given, for backward
 * compatibility):
 * - Strips spaces, dashes, parentheses, dots.
 * - A number already in international form (leading "+" or "00") is trusted.
 * - A national number has its trunk prefix (e.g. RU "8", most countries "0")
 *   replaced with the country's dial code.
 * - Returns undefined when the national length is not plausible for the country
 *   (so a Pakistani number becomes +92…, and junk is rejected rather than
 *   force-fitted to the wrong country).
 *
 * @param countryCode ISO 3166-1 alpha-2 (e.g. "ru", "pk"). Defaults to "ru".
 */
export function normalizePhone(raw?: string | null, countryCode?: string): string | undefined {
  if (!raw) return undefined;
  const meta = countryMeta(countryCode);
  const isIntl = /^\s*\+/.test(raw) || /^\s*00\d/.test(raw);

  // Keep only digits (drop +, spaces, punctuation, letters).
  let digits = raw.replace(/\D+/g, '');
  if (!digits) return undefined;

  if (isIntl) {
    // Already international: "00<cc>…" → "<cc>…", a leading "+" dropped already.
    if (digits.startsWith('00')) digits = digits.slice(2);
  } else if (meta.dial && digits.startsWith(meta.dial) && withinNat(digits.length - meta.dial.length, meta)) {
    // National number that already carries its own country code (no "+").
    // (digits is already "<dial><national>".)
  } else {
    // Plain national number: strip the trunk prefix, prefix the dial code.
    let nat = digits;
    if (meta.trunk && nat.length > meta.trunk.length && nat.startsWith(meta.trunk)) {
      nat = nat.slice(meta.trunk.length);
    }
    digits = meta.dial + nat;
  }

  // Validate. For this country's own numbers, enforce its national length;
  // for a number from another country (kept via the intl branch), allow the
  // general E.164 range (8–15 digits total).
  if (meta.dial && digits.startsWith(meta.dial)) {
    if (!withinNat(digits.length - meta.dial.length, meta)) return undefined;
  } else if (digits.length < 8 || digits.length > 15) {
    return undefined;
  }

  return '+' + digits;
}

/** Is a national significant-number length plausible for this country? */
function withinNat(len: number, meta: { natMin: number; natMax: number }): boolean {
  return len >= meta.natMin && len <= meta.natMax;
}

/**
 * Format the FIRST phone found in a free-text string (some sources return
 * several joined by commas). Returns the normalized primary number.
 */
export function primaryPhone(raw?: string | null, countryCode?: string): string | undefined {
  if (!raw) return undefined;
  const first = raw.split(/[,;/]+/)[0];
  return normalizePhone(first, countryCode);
}

// A phone-shaped token: optional "+", then a run of digits and separators long
// enough to be a phone (≥8 chars overall). Used to pull a number out of card
// text where sources don't expose it in a dedicated element.
const PHONE_CANDIDATE = /\+?\d[\d\s().\-]{6,}\d/g;

/**
 * Extract the first plausible phone number from a block of free text, validated
 * for the given country. Returns the normalized E.164 number, or undefined.
 */
export function extractPhone(text?: string | null, countryCode?: string): string | undefined {
  if (!text) return undefined;
  for (const m of text.matchAll(PHONE_CANDIDATE)) {
    const norm = normalizePhone(m[0], countryCode);
    if (norm) return norm;
  }
  return undefined;
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
export function dedupKey(lead: Lead, countryCode?: string): string {
  const phone = primaryPhone(lead.phone, countryCode);
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

/**
 * Apply normalization + isIndividual tagging to a freshly-collected lead.
 * @param countryCode ISO 3166-1 alpha-2 of the search, so the phone normalizes
 *   to the right country (defaults to Russia when omitted).
 */
export function finalizeLead(lead: Lead, countryCode?: string): Lead {
  const phone = primaryPhone(lead.phone, countryCode) ?? lead.phone;
  const out: Lead = { ...lead, phone };
  out.isIndividual = isIndividual(out);
  return out;
}
