import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { z } from 'zod';

// Load env from the server's own folder first (if present), then fall back to
// the monorepo ROOT .env. dotenv does not override already-set vars, so a local
// server/.env wins, and the documented root-level .env is picked up too.
// Works in dev (server/src) and build (server/dist): both sit 2 levels below root.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv(); // process cwd/.env
loadEnv({ path: join(here, '..', '.env') }); // server/.env
loadEnv({ path: join(here, '..', '..', '.env') }); // project root .env

/**
 * Centralized, zod-validated configuration. All of GrabLeads runs free:
 * no paid keys are required. The 2GIS public web key has a working default.
 */

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(5050),
  // MongoDB connection. Use a MongoDB Atlas connection string (free tier works):
  //   MONGODB_URI=mongodb+srv://USER:PASS@cluster0.xxxxx.mongodb.net/?retryWrites=true&w=majority
  // Leave blank and the server still boots, but lead/job routes return a clear
  // "configure MONGODB_URI" error until it is set.
  MONGODB_URI: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : '')),
  MONGODB_DB: z.string().trim().default('grableads'),
  // Secret used to sign login tokens (JWT). Set a long random string in .env for
  // production. A dev default is provided so the server still boots locally.
  JWT_SECRET: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : 'dev-insecure-change-me')),
  // How long a login stays valid (e.g. 7d, 24h, 30m).
  JWT_EXPIRES_IN: z.string().trim().default('7d'),
  // Free 2GIS key. A no-cost "demo" key from the 2GIS Platform Manager works
  // here (see README). Empty → the 2GIS source is simply skipped; OSM + Yandex
  // + Avito still run. You may also paste the public web key from 2gis.ru.
  TWOGIS_WEB_KEY: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : '')),
  // API host for 2GIS. Official host works with a free demo key; switch to
  // catalog.api.2gis.ru if you use the 2gis.ru public web key instead.
  TWOGIS_API_HOST: z.string().trim().default('catalog.api.2gis.com'),
  OVERPASS_URL: z
    .string()
    .url()
    .default('https://overpass-api.de/api/interpreter'),
  YANDEX_HEADLESS: z
    .string()
    .optional()
    .transform((v) => v !== 'false'), // default true
  PROXY_URL: z
    .string()
    .trim()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  REQ_PER_SEC: z.coerce.number().positive().default(5),
  ENRICH_EMAIL: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('[env] Invalid configuration:', parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;

export const USER_AGENT =
  'GrabLeadsBot/1.0 (+https://grabatoz.ae; B2B lead research)';
