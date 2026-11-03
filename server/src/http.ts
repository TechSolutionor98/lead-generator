import axios, { type AxiosInstance } from 'axios';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { env, USER_AGENT } from './env.js';

/**
 * Single shared axios instance. Honors the optional PROXY_URL for every
 * outbound call (2GIS, Overpass, and the email enricher). Playwright is
 * configured with the same proxy separately in browser.ts.
 */
const proxyAgent = env.PROXY_URL ? new HttpsProxyAgent(env.PROXY_URL) : undefined;

export const http: AxiosInstance = axios.create({
  timeout: 15_000,
  headers: {
    'User-Agent': USER_AGENT,
    'Accept-Language': 'ru-RU,ru;q=0.9,en;q=0.6',
  },
  // Route both http and https traffic through the proxy when configured.
  httpAgent: proxyAgent,
  httpsAgent: proxyAgent,
  // We handle non-2xx ourselves (incl. 5xx → backoff/retry), so never throw on
  // status. This lets adapters see 429/502/503/504 (e.g. Overpass overloaded)
  // and retry them, instead of axios throwing before the retry logic runs.
  validateStatus: () => true,
});

export const usingProxy = Boolean(env.PROXY_URL);
