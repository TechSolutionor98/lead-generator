import { MongoClient, type Db, type Collection } from 'mongodb';
import { env } from './env.js';
import type { GeoBox, JobCounts, JobParams, JobStatus } from './types.js';

/**
 * MongoDB connection + collection accessors.
 *
 * One lazily-created client is shared for the whole process (the driver pools
 * connections internally). Everything that touches the database goes through
 * `getDb()`, which throws a clear, actionable error if MONGODB_URI is not set —
 * so the server still boots and the UI still loads, and only DB calls fail with
 * a helpful message instead of crashing the process.
 */

// ---- Document shapes (what we actually store) ------------------------------

/** A job record. _id is the job id (nanoid). */
export interface JobDoc {
  _id: string;
  status: JobStatus;
  params: JobParams;
  counts: JobCounts;
  error?: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * A globally-unique business, keyed by its dedup fingerprint (_id = dedupKey).
 * `firstJobId` is the run that first discovered it — that's what makes the
 * "only show NEW leads on re-runs" behaviour work: a job's results are exactly
 * the leads whose firstJobId == that job.
 */
export interface LeadDoc {
  _id: string; // dedupKey
  source: string;
  name: string;
  category?: string | null;
  phone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city: string;
  lat?: number | null;
  lng?: number | null;
  rating?: number | null;
  reviewsCount?: number | null;
  sourceUrl?: string | null;
  isIndividual: boolean;
  collectedAt: string;
  firstJobId: string; // the run that first discovered this business
  firstSeenAt: string; // ISO — when we first ever saw it
  lastSeenAt: string; // ISO — most recent run that saw it again
  jobIds: string[]; // every run that has seen it
  seenCount: number; // how many times it has been encountered
}

/** A cached geocoder result, keyed by the place string. */
export interface GeoDoc {
  _id: string; // place key, e.g. "Москва, Москва"
  center: [number, number];
  spn: [number, number];
  bbox: [number, number, number, number];
}

// ---- Connection ------------------------------------------------------------

let client: MongoClient | null = null;
let connectPromise: Promise<Db> | null = null;

export class DbNotConfiguredError extends Error {
  constructor() {
    super(
      'MongoDB is not configured. Add your MongoDB Atlas connection string to ' +
        '.env as MONGODB_URI (see README → "MongoDB setup"), then restart the server.',
    );
    this.name = 'DbNotConfiguredError';
  }
}

async function connect(): Promise<Db> {
  if (!env.MONGODB_URI) throw new DbNotConfiguredError();
  client = new MongoClient(env.MONGODB_URI, {
    // Fail fast with a readable error instead of hanging if the URI/cluster is wrong.
    serverSelectionTimeoutMS: 10_000,
  });
  await client.connect();
  const db = client.db(env.MONGODB_DB);
  await ensureIndexes(db);
  return db;
}

/** Get the shared Db handle, connecting on first use. */
export function getDb(): Promise<Db> {
  if (!connectPromise) {
    connectPromise = connect().catch((err) => {
      // Reset so a later call (e.g. after the user fixes .env) can retry.
      connectPromise = null;
      throw err;
    });
  }
  return connectPromise;
}

async function ensureIndexes(db: Db): Promise<void> {
  // `firstJobId` powers per-run result queries; `jobIds` helps lookups by run.
  await db.collection<LeadDoc>('leads').createIndexes([
    { key: { firstJobId: 1 } },
    { key: { jobIds: 1 } },
    { key: { lastSeenAt: -1 } },
  ]);
  await db.collection<JobDoc>('jobs').createIndexes([{ key: { createdAt: -1 } }]);
}

export async function jobs(): Promise<Collection<JobDoc>> {
  return (await getDb()).collection<JobDoc>('jobs');
}
export async function leads(): Promise<Collection<LeadDoc>> {
  return (await getDb()).collection<LeadDoc>('leads');
}
export async function geoCache(): Promise<Collection<GeoDoc>> {
  return (await getDb()).collection<GeoDoc>('geo_cache');
}

/** True if a connection string is configured (not whether it actually works). */
export function isDbConfigured(): boolean {
  return Boolean(env.MONGODB_URI);
}

/** Eagerly connect at startup (optional) so problems surface immediately. */
export async function connectAtStartup(): Promise<void> {
  await getDb();
}

export async function closeDb(): Promise<void> {
  if (client) {
    await client.close();
    client = null;
    connectPromise = null;
  }
}

export type { GeoBox };
