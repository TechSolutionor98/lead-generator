import { http } from './http.js';

/**
 * Query translation. The map/search sources find far more businesses when the
 * keywords are in the local language of the country being searched (e.g. Russian
 * keywords in Russia). So the user can type queries in plain English and we
 * translate them into the search language before scraping.
 *
 * Two layers, free + no API key:
 *   1. A curated dictionary of the B2B hardware terms this tool is built around
 *      — instant, offline, and high quality.
 *   2. A best-effort fallback to the free MyMemory API for anything else, with
 *      output cleanup. Results are cached so each phrase is translated once.
 *
 * English targets (`en`) are a no-op, so Pakistan/UAE/etc. keep their English
 * keywords unchanged. A query already written in the target script is left as-is
 * (so existing Russian queries still work).
 */

// Curated English → Russian for the hardware/IT lead domain.
const RU_DICT: Record<string, string> = {
  'computer store': 'компьютерный магазин',
  'computer shop': 'компьютерный магазин',
  'computer market': 'компьютерный магазин',
  'system integrator': 'системный интегратор',
  'computer repair': 'сервисный центр компьютеров',
  'computer repair service': 'сервисный центр компьютеров',
  'computer service center': 'сервисный центр компьютеров',
  'service center': 'сервисный центр',
  'computer components wholesale': 'оптовая продажа комплектующих',
  'computer parts wholesale': 'оптовая продажа комплектующих',
  'components wholesale': 'оптовая продажа комплектующих',
  'wholesale computer parts': 'оптовая продажа комплектующих',
  'mining equipment': 'майнинг оборудование',
  'mining hardware': 'майнинг оборудование',
  'laptop store': 'магазин ноутбуков',
  'laptop shop': 'магазин ноутбуков',
  'electronics store': 'магазин электроники',
  'it company': 'ИТ компания',
  'it solutions': 'ИТ решения',
  'server equipment': 'серверное оборудование',
  'network equipment': 'сетевое оборудование',
  'printer store': 'магазин принтеров',
  'cctv store': 'магазин видеонаблюдения',
  'computer accessories': 'компьютерные аксессуары',
};

const DICTS: Record<string, Record<string, string>> = { ru: RU_DICT };

// `${lang}|${lowercased text}` → translated text.
const cache = new Map<string, string>();

function hasCyrillic(s: string): boolean {
  return /[А-Яа-яЁё]/.test(s);
}

/** Does this text already appear to be in the target language's script? */
function alreadyInTargetScript(text: string, lang: string): boolean {
  if (lang === 'ru') return hasCyrillic(text);
  return false;
}

/** MyMemory sometimes prefixes junk like "| -"; trim leading non-letters. */
function cleanTranslation(s: string): string {
  return s.replace(/^[^\p{L}\p{N}]+/u, '').replace(/\s+/g, ' ').trim();
}

interface MyMemoryResponse {
  responseData?: { translatedText?: string };
  responseStatus?: number;
}

/**
 * Translate one query into `lang` (ISO 639-1). Returns the original text when
 * the target is English, the text is already in the target script, or
 * translation fails.
 */
export async function translateQuery(
  text: string,
  lang: string,
  log?: (m: string) => void,
): Promise<string> {
  const q = text.trim();
  if (!q || lang === 'en') return q;
  if (alreadyInTargetScript(q, lang)) return q;

  const key = `${lang}|${q.toLowerCase()}`;
  const cached = cache.get(key);
  if (cached) return cached;

  // 1. Curated dictionary (exact, lowercased match).
  const dictHit = DICTS[lang]?.[q.toLowerCase()];
  if (dictHit) {
    cache.set(key, dictHit);
    return dictHit;
  }

  // 2. Free API fallback (best effort).
  try {
    const res = await http.get<MyMemoryResponse>('https://api.mymemory.translated.net/get', {
      params: { q, langpair: `en|${lang}` },
      timeout: 8000,
    });
    const raw = res.data?.responseData?.translatedText;
    if (res.status < 400 && typeof raw === 'string') {
      const out = cleanTranslation(raw);
      if (out && out.toLowerCase() !== q.toLowerCase()) {
        cache.set(key, out);
        return out;
      }
    }
  } catch (err) {
    log?.(`[translate] "${q}" → ${lang} failed: ${(err as Error).message}`);
  }

  // Fall back to the original text so the search still runs.
  return q;
}
