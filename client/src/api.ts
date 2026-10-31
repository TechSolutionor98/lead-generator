import type { Country, JobEvent, LeadsResponse, NamedCode, SourceInfo, Target } from './types';

/** Typed fetch helpers + an SSE subscription helper for job events. */

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getSources(): Promise<SourceInfo[]> {
  const data = await json<{ sources: SourceInfo[] }>(await fetch('/api/sources'));
  return data.sources;
}

export async function getCountries(): Promise<Country[]> {
  const data = await json<{ countries: Country[] }>(await fetch('/api/countries'));
  return data.countries;
}

/** Regions/states for a country (auto-fetched when a country is picked). */
export async function getRegions(countryCode: string): Promise<NamedCode[]> {
  const data = await json<{ regions: NamedCode[] }>(
    await fetch(`/api/regions?country=${encodeURIComponent(countryCode)}`),
  );
  return data.regions;
}

/** Cities for a region (auto-fetched when a region is picked). */
export async function getCities(countryCode: string, regionCode: string): Promise<string[]> {
  const data = await json<{ cities: string[] }>(
    await fetch(
      `/api/cities?country=${encodeURIComponent(countryCode)}&region=${encodeURIComponent(regionCode)}`,
    ),
  );
  return data.cities;
}

export interface CreateJobBody {
  sources: string[];
  queries: string[];
  targets: Target[];
  limitPerQuery: number;
  enrichEmail: boolean;
  delayMs: number;
}

export async function createJob(body: CreateJobBody): Promise<{ id: string }> {
  return json(
    await fetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function cancelJob(id: string): Promise<void> {
  await fetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
}

export interface LeadsQuery {
  page?: number;
  pageSize?: number;
  search?: string;
  excludeIndividuals?: boolean;
}

export async function getLeads(jobId: string, q: LeadsQuery): Promise<LeadsResponse> {
  const params = new URLSearchParams();
  if (q.page) params.set('page', String(q.page));
  if (q.pageSize) params.set('pageSize', String(q.pageSize));
  if (q.search) params.set('search', q.search);
  if (q.excludeIndividuals) params.set('excludeIndividuals', 'true');
  return json(await fetch(`/api/jobs/${jobId}/leads?${params.toString()}`));
}

/** Build the export URL for a job (csv|xlsx), optionally for selected ids. */
export function exportUrl(
  jobId: string,
  format: 'csv' | 'xlsx',
  opts: { ids?: string[]; excludeIndividuals?: boolean } = {},
): string {
  const params = new URLSearchParams({ format });
  if (opts.ids && opts.ids.length) params.set('ids', opts.ids.join(','));
  if (opts.excludeIndividuals) params.set('excludeIndividuals', 'true');
  return `/api/jobs/${jobId}/export?${params.toString()}`;
}

/**
 * Download an export as a file. Fetches the bytes inside the page and saves them
 * via a Blob + object URL, instead of navigating to the URL. This avoids
 * download-manager browser extensions (which hook page navigations and can fail
 * with "connection was closed") and keeps the download inside this session.
 */
export async function downloadExport(
  jobId: string,
  format: 'csv' | 'xlsx',
  opts: { ids?: string[]; excludeIndividuals?: boolean } = {},
): Promise<void> {
  const res = await fetch(exportUrl(jobId, format, opts));
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Export failed (HTTP ${res.status})`);
  }
  const blob = await res.blob();

  // Prefer the server-provided filename; fall back to a sensible default.
  const cd = res.headers.get('content-disposition') || '';
  const match = /filename="?([^"]+)"?/.exec(cd);
  const filename = match?.[1] || `grableads-${new Date().toISOString().slice(0, 10)}.${format}`;

  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release the blob after the browser has grabbed it.
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
}

/** Subscribe to a job's SSE stream. Returns an unsubscribe function. */
export function subscribeJob(jobId: string, onEvent: (e: JobEvent) => void): () => void {
  const es = new EventSource(`/api/jobs/${jobId}/events`);
  es.onmessage = (ev) => {
    try {
      onEvent(JSON.parse(ev.data) as JobEvent);
    } catch {
      /* ignore malformed */
    }
  };
  es.onerror = () => {
    // The server closes the stream when the job finishes; that surfaces here.
    es.close();
  };
  return () => es.close();
}

// --- Avito import -----------------------------------------------------------

export interface AvitoPreview {
  columns: string[];
  rowCount: number;
  sample: Record<string, unknown>[];
}

export async function previewAvito(file: File): Promise<AvitoPreview> {
  const fd = new FormData();
  fd.append('file', file);
  return json(await fetch('/api/import/avito/preview', { method: 'POST', body: fd }));
}

export interface AvitoImportResult {
  id: string;
  parsed: number;
  inserted: number;
}

export async function importAvito(
  file: File,
  mapping: Record<string, string>,
  city: string,
  jobId?: string,
): Promise<AvitoImportResult> {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('mapping', JSON.stringify(mapping));
  fd.append('city', city);
  if (jobId) fd.append('jobId', jobId);
  return json(await fetch('/api/import/avito', { method: 'POST', body: fd }));
}
