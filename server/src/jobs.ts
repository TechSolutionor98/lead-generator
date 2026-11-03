import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import type { Job, JobEvent, JobParams, Lead } from './types.js';
import { getSource } from './sources/index.js';
import {
  createJob,
  setJobStatus,
  insertLead,
  computeCounts,
  saveJobCounts,
  getJob,
} from './db.js';
import { enrichLead } from './enrich.js';
import { resolveGeo } from './geocode.js';
import { translateQuery } from './translate.js';
import { countryMeta } from './country.js';
import { env } from './env.js';
import type { GeoBox } from './types.js';

/**
 * Job runner. Fans out (source × query × city) tasks, persists deduped leads to
 * SQLite as they stream in (crash-safe), and broadcasts SSE events to any
 * connected clients via a per-job EventEmitter.
 */

interface RunningJob {
  emitter: EventEmitter;
  abort: AbortController;
  done: boolean;
  lastEvent?: JobEvent;
}

const running = new Map<string, RunningJob>();

/** Resolve after `ms`, or immediately if the signal aborts. */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

function busFor(jobId: string): RunningJob {
  let rj = running.get(jobId);
  if (!rj) {
    rj = { emitter: new EventEmitter(), abort: new AbortController(), done: false };
    rj.emitter.setMaxListeners(50);
    running.set(jobId, rj);
  }
  return rj;
}

export function subscribe(jobId: string, listener: (e: JobEvent) => void): () => void {
  const rj = busFor(jobId);
  rj.emitter.on('event', listener);
  return () => rj.emitter.off('event', listener);
}

export function isJobDone(jobId: string): boolean {
  return running.get(jobId)?.done ?? true;
}

function emit(jobId: string, e: JobEvent): void {
  const rj = busFor(jobId);
  rj.lastEvent = e;
  rj.emitter.emit('event', e);
}

export function cancelJob(jobId: string): void {
  running.get(jobId)?.abort.abort();
}

/** Create a job row + kick off async processing. */
export async function startJob(params: JobParams): Promise<Job> {
  const id = nanoid(12);
  const job = await createJob(id, params);
  // Run without blocking the request; surface any late failure to the client.
  void runJob(id, params).catch((err) => {
    const message = (err as Error).message;
    emit(id, { type: 'log', level: 'error', message: `job failed: ${message}` });
    emit(id, { type: 'error', message });
    busFor(id).done = true;
    void setJobStatus(id, 'error', message).catch(() => undefined);
  });
  return job;
}

async function runJob(jobId: string, params: JobParams): Promise<void> {
  const rj = busFor(jobId);
  await setJobStatus(jobId, 'running');

  const log = (level: 'info' | 'warn' | 'error' | 'captcha', message: string) =>
    emit(jobId, { type: 'log', level, message });

  // Resolve each target to coordinates once (cached across sources/queries).
  type Place = {
    label: string;
    region: string;
    country: string;
    countryCode: string;
    wholeRegion: boolean;
    geo: GeoBox;
  };
  const places: Place[] = [];
  for (const t of params.targets) {
    const geo = await resolveGeo(t.countryCode, t.country, t.region, t.city, (m) => log('info', m));
    const label = t.city || t.region || t.country;
    if (!geo) {
      log('warn', `could not locate ${label} (${t.country}) — skipping`);
      continue;
    }
    const scope = t.city ? '' : t.region ? ' (whole region)' : ' (whole country)';
    places.push({
      label,
      region: t.region || t.country,
      country: t.country,
      countryCode: t.countryCode,
      wholeRegion: !t.city,
      geo,
    });
    log('info', `📍 ${label}${scope} located`);
  }

  // Localize each query into each place's search language (e.g. English →
  // Russian for Russia) so the user can type English but the map sources still
  // get native keywords. English-language countries are a no-op. Cached, so each
  // (query, language) pair is translated at most once.
  const localized = new Map<string, string>(); // `${lang}|${query}` → localized
  for (const query of params.queries) {
    for (const place of places) {
      const lang = countryMeta(place.countryCode).hl;
      const key = `${lang}|${query}`;
      if (localized.has(key)) continue;
      const out = await translateQuery(query, lang, (m) => log('info', m));
      localized.set(key, out);
      if (out !== query) log('info', `🌐 "${query}" → "${out}" (${lang})`);
    }
  }
  const localize = (query: string, countryCode: string): string =>
    localized.get(`${countryMeta(countryCode).hl}|${query}`) ?? query;

  // Build the task matrix: each enabled, requested source × query × place.
  const tasks: {
    sourceId: string;
    query: string;
    place: Place;
  }[] = [];
  for (const sourceId of params.sources) {
    const src = getSource(sourceId);
    if (!src || !src.enabled()) {
      log('warn', `source "${sourceId}" is not available for live search, skipping`);
      continue;
    }
    for (const query of params.queries) {
      for (const place of places) {
        tasks.push({ sourceId, query: localize(query, place.countryCode), place });
      }
    }
  }

  const totalTasks = tasks.length;
  let completedTasks = 0;

  const progress = async () => {
    const counts = await computeCounts(jobId);
    await saveJobCounts(jobId, counts);
    emit(jobId, { type: 'progress', done: completedTasks, total: totalTasks, counts });
  };

  if (totalTasks === 0) {
    log('warn', 'no runnable (source × query × city) tasks');
    await finish(jobId, 'done');
    return;
  }

  log('info', `starting ${totalTasks} search tasks across ${params.sources.join(', ')}`);
  await progress();

  // Run sources concurrently, but process each source's tasks sequentially to
  // respect its own rate limit / single browser session (esp. Yandex).
  const bySource = new Map<string, typeof tasks>();
  for (const t of tasks) {
    const arr = bySource.get(t.sourceId) ?? [];
    arr.push(t);
    bySource.set(t.sourceId, arr);
  }

  await Promise.all(
    [...bySource.entries()].map(async ([sourceId, srcTasks]) => {
      const src = getSource(sourceId)!;
      for (const t of srcTasks) {
        if (rj.abort.signal.aborted) break;
        try {
          for await (let lead of src.search({
            query: t.query,
            city: t.place.label,
            region: t.place.region,
            country: t.place.country,
            countryCode: t.place.countryCode,
            wholeRegion: t.place.wholeRegion,
            geo: t.place.geo,
            limit: params.limitPerQuery,
            log: (m) => log('info', m),
            signal: rj.abort.signal,
          })) {
            if (rj.abort.signal.aborted) break;
            lead = await maybeEnrich(lead, params, t.place.countryCode);
            const inserted = await insertLead(jobId, lead);
            if (inserted) emit(jobId, { type: 'lead', lead });
            // Optional pacing: pause after each lead (cancellable).
            if (params.delayMs > 0) await sleep(params.delayMs, rj.abort.signal);
          }
        } catch (err) {
          log('error', `[${sourceId}] ${t.place.label}/"${t.query}": ${(err as Error).message}`);
        } finally {
          completedTasks += 1;
          await progress();
        }
      }
    }),
  );

  await finish(jobId, rj.abort.signal.aborted ? 'cancelled' : 'done');
}

async function maybeEnrich(lead: Lead, params: JobParams, countryCode: string): Promise<Lead> {
  const wantEnrich = params.enrichEmail || env.ENRICH_EMAIL;
  if (!wantEnrich) return lead;
  try {
    return await enrichLead(lead, countryCode);
  } catch {
    return lead;
  }
}

async function finish(jobId: string, status: 'done' | 'cancelled' | 'error'): Promise<void> {
  const counts = await computeCounts(jobId);
  await saveJobCounts(jobId, counts);
  await setJobStatus(jobId, status);
  emit(jobId, { type: 'done', counts });
  const rj = busFor(jobId);
  rj.done = true;
}

export { getJob };
