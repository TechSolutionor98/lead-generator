import { chromium, type Browser } from 'playwright';
import { env, USER_AGENT } from './env.js';

/**
 * Lazy, shared Chromium instance for the Yandex scraper. We launch one browser
 * and reuse it across searches to stay light. Honors PROXY_URL and the
 * YANDEX_HEADLESS flag (set false to watch the browser / solve a captcha).
 */
let browserPromise: Promise<Browser> | null = null;

export async function getBrowser(): Promise<Browser> {
  if (!browserPromise) {
    browserPromise = chromium
      .launch({
        headless: env.YANDEX_HEADLESS,
        proxy: env.PROXY_URL ? { server: env.PROXY_URL } : undefined,
        args: ['--disable-blink-features=AutomationControlled'],
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

/** A fresh browser context with a realistic UA + Russian locale. */
export async function newContext() {
  const browser = await getBrowser();
  return browser.newContext({
    userAgent: USER_AGENT,
    locale: 'ru-RU',
    timezoneId: 'Europe/Moscow',
    viewport: { width: 1366, height: 900 },
  });
}

export async function closeBrowser(): Promise<void> {
  if (browserPromise) {
    const b = await browserPromise.catch(() => null);
    browserPromise = null;
    if (b) await b.close().catch(() => undefined);
  }
}
