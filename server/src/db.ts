import type { GeoBox, Job, JobCounts, JobParams, JobStatus, Lead } from './types.js';
import { dedupKey } from './dedup.js';
import { geoCache, jobs as jobsCol, leads as leadsCol, type LeadDoc } from './mongo.js';

/**
 * Data layer (MongoDB).
 *
 * Cross-run deduplication: the `leads` collection holds ONE document per unique
 * business ever seen, keyed by its dedup fingerprint (_id = dedupKey). Each job's
 * results are the leads it *first discovered* (firstJobId == jobId). So re-running
 * the same city later only surfaces businesses that are genuinely new — anything
 * seen in a previous run is recognised and skipped (its lastSeenAt is bumped).
 *
 * All functions are async (the Mongo driver is async, unlike the old SQLite one).
 */

const nowIso = () => new Date().toISOString();

const emptyCounts = (): JobCounts => ({
  total: 0,
  bySource: {},
  byCity: {},
  byCategory: {},
});

// ---------------------------------------------------------------------------
// Geo cache (Nominatim results, keyed by place string)
// ---------------------------------------------------------------------------

export async function getGeoCache(key: string): Promise<GeoBox | undefined> {
  const col = await geoCache();
  const doc = await col.findOne({ _id: key });
  if (!doc) return undefined;
  return { center: doc.center, spn: doc.spn, bbox: doc.bbox };
}

export async function setGeoCache(key: string, g: GeoBox): Promise<void> {
  const col = await geoCache();
  await col.updateOne(
    { _id: key },
    { $set: { center: g.center, spn: g.spn, bbox: g.bbox } },
    { upsert: true },
  );
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export async function createJob(id: string, params: JobParams): Promise<Job> {
  const ts = nowIso();
  const counts = emptyCounts();
  const col = await jobsCol();
  await col.insertOne({
    _id: id,
    status: 'pending',
    params,
    counts,
    error: null,
    createdAt: ts,
    updatedAt: ts,
  });
  return { id, status: 'pending', params, counts, createdAt: ts, updatedAt: ts };
}

export async function setJobStatus(id: string, status: JobStatus, error?: string): Promise<void> {
  const col = await jobsCol();
  await col.updateOne(
    { _id: id },
    { $set: { status, error: error ?? null, updatedAt: nowIso() } },
  );
}

export async function saveJobCounts(id: string, counts: JobCounts): Promise<void> {
  const col = await jobsCol();
  await col.updateOne({ _id: id }, { $set: { counts, updatedAt: nowIso() } });
}

export async function getJob(id: string): Promise<Job | undefined> {
  const col = await jobsCol();
  const doc = await col.findOne({ _id: id });
  if (!doc) return undefined;
  return {
    id: doc._id,
    status: doc.status,
    params: doc.params,
    counts: doc.counts,
    error: doc.error ?? undefined,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

function leadToDocFields(lead: Lead): Omit<LeadDoc, '_id' | 'firstJobId' | 'firstSeenAt' | 'lastSeenAt' | 'jobIds' | 'seenCount'> {
  return {
    source: lead.source,
    name: lead.name,
    category: lead.category ?? null,
    phone: lead.phone ?? null,
    email: lead.email ?? null,
    website: lead.website ?? null,
    address: lead.address ?? null,
    city: lead.city,
    lat: lead.lat ?? null,
    lng: lead.lng ?? null,
    rating: lead.rating ?? null,
    reviewsCount: lead.reviewsCount ?? null,
    sourceUrl: lead.sourceUrl ?? null,
    isIndividual: Boolean(lead.isIndividual),
    collectedAt: lead.collectedAt,
  };
}

/**
 * Insert a lead with GLOBAL cross-run dedup. Atomic upsert on the dedup key:
 *   - brand new business (never seen in any run) → inserted, returns true (NEW).
 *   - already seen before (this run or an earlier one) → not re-inserted; its
 *     lastSeenAt/jobIds/seenCount are updated; returns false.
 *
 * Because a job's results are leads whose firstJobId == jobId, returning false
 * here means the lead is intentionally NOT shown/counted for this run.
 */
export async function insertLead(jobId: string, lead: Lead): Promise<boolean> {
  const col = await leadsCol();
  const _id = dedupKey(lead);
  const ts = nowIso();
  const res = await col.updateOne(
    { _id },
    {
      $setOnInsert: {
        ...leadToDocFields(lead),
        firstJobId: jobId,
        firstSeenAt: ts,
      },
      $set: { lastSeenAt: ts },
      $addToSet: { jobIds: jobId },
      $inc: { seenCount: 1 },
    },
    { upsert: true },
  );
  return res.upsertedCount === 1;
}

/**
 * Mark leads as exported so they're never shown/counted again. Called right
 * after a successful CSV/XLSX export. Returns how many were newly marked.
 */
export async function markExported(ids: string[]): Promise<number> {
  if (ids.length === 0) return 0;
  const col = await leadsCol();
  const res = await col.updateMany(
    { _id: { $in: ids }, exportedAt: null },
    { $set: { exportedAt: nowIso() } },
  );
  return res.modifiedCount;
}

function docToLead(doc: LeadDoc): Lead {
  return {
    source: doc.source,
    name: doc.name,
    category: doc.category ?? undefined,
    phone: doc.phone ?? undefined,
    email: doc.email ?? undefined,
    website: doc.website ?? undefined,
    address: doc.address ?? undefined,
    city: doc.city,
    lat: doc.lat ?? undefined,
    lng: doc.lng ?? undefined,
    rating: doc.rating ?? undefined,
    reviewsCount: doc.reviewsCount ?? undefined,
    sourceUrl: doc.sourceUrl ?? undefined,
    isIndividual: Boolean(doc.isIndividual),
    collectedAt: doc.collectedAt,
  };
}

export interface LeadQuery {
  jobId: string;
  search?: string;
  excludeIndividuals?: boolean;
  page?: number;
  pageSize?: number;
  ids?: string[]; // dedup-key ids (Mongo _id) for selected-rows export
}

/** Recompute aggregate counts for a job from its newly-discovered, un-exported leads. */
export async function computeCounts(jobId: string): Promise<JobCounts> {
  const col = await leadsCol();
  const counts = emptyCounts();
  const cursor = col.find(
    { firstJobId: jobId, exportedAt: null },
    { projection: { source: 1, city: 1, category: 1 } },
  );
  for await (const r of cursor) {
    counts.total += 1;
    counts.bySource[r.source] = (counts.bySource[r.source] ?? 0) + 1;
    counts.byCity[r.city] = (counts.byCity[r.city] ?? 0) + 1;
    const cat = r.category || '(не указано)';
    counts.byCategory[cat] = (counts.byCategory[cat] ?? 0) + 1;
  }
  return counts;
}

function buildFilter(q: LeadQuery): Record<string, unknown> {
  // A job's rows = the leads it first discovered (the "new" ones for that run),
  // excluding any already exported (exporting "consumes" a lead → never shown
  // again). `exportedAt: null` matches both unset and null.
  const filter: Record<string, unknown> = { firstJobId: q.jobId, exportedAt: null };

  if (q.excludeIndividuals) filter.isIndividual = { $ne: true };

  if (q.ids && q.ids.length > 0) filter._id = { $in: q.ids };

  if (q.search && q.search.trim()) {
    const rx = new RegExp(escapeRegex(q.search.trim()), 'i');
    filter.$or = [
      { name: rx },
      { category: rx },
      { phone: rx },
      { email: rx },
      { website: rx },
      { address: rx },
      { city: rx },
    ];
  }
  return filter;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function countLeads(q: LeadQuery): Promise<number> {
  const col = await leadsCol();
  return col.countDocuments(buildFilter(q));
}

/** Fetch leads (with optional paging). Returns rows + their string ids (_id). */
export async function queryLeads(q: LeadQuery): Promise<{ id: string; lead: Lead }[]> {
  const col = await leadsCol();
  let cursor = col.find(buildFilter(q)).sort({ firstSeenAt: 1, _id: 1 });
  if (q.pageSize && q.pageSize > 0) {
    const page = Math.max(1, q.page ?? 1);
    cursor = cursor.skip((page - 1) * q.pageSize).limit(q.pageSize);
  }
  const docs = await cursor.toArray();
  return docs.map((d) => ({ id: d._id, lead: docToLead(d) }));
}
