import type { Country, JobEvent, LeadsResponse, NamedCode, SourceInfo, Target } from './types';

/** Typed fetch helpers + an SSE subscription helper for job events. */

/**
 * Base URL of the backend API.
 *
 * - Leave `VITE_API_URL` empty (or unset) to use same-origin relative paths,
 *   which the Vite dev proxy forwards to the server (local dev convenience).
 * - Set it to the backend's full origin (e.g. `http://localhost:5050` in dev,
 *   or `https://api.yourdomain.com` in production) to call the backend
 *   directly — this is how the frontend and backend run as separate services.
 *
 * Trailing slashes are trimmed so `${API_BASE}/api/...` is always well-formed.
 */
const API_BASE = (
  import.meta.env.NEXT_PUBLIC_API_URL ??
  import.meta.env.VITE_API_URL ??
  ''
).replace(/\/+$/, '');

/** Prefix an `/api/...` path with the configured backend base URL. */
function api(path: string): string {
  return `${API_BASE}${path}`;
}

// --- Auth token storage -----------------------------------------------------
// The JWT from /api/auth/login is kept in localStorage and sent on every
// request as `Authorization: Bearer <token>`. A 401 clears it and notifies the
// app so it can show the login screen again.

const TOKEN_KEY = 'grableads_token';
let onUnauthorized: (() => void) | null = null;

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* storage unavailable (private mode) — token stays in memory only */
  }
}

/** Register a callback fired when the server rejects the token (401). */
export function setUnauthorizedHandler(fn: (() => void) | null): void {
  onUnauthorized = fn;
}

function authHeaders(extra?: HeadersInit): HeadersInit {
  const t = getToken();
  return { ...(extra || {}), ...(t ? { Authorization: `Bearer ${t}` } : {}) };
}

/** fetch() that attaches the auth token and surfaces 401s to the app. */
async function authFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const res = await fetch(api(path), { ...init, headers: authHeaders(init.headers) });
  if (res.status === 401) {
    setToken(null);
    onUnauthorized?.();
  }
  return res;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

// --- Authentication ---------------------------------------------------------

export interface AuthUser {
  username: string;
  name?: string | null;
}

/** Log in with username + password; stores the token on success. */
export async function login(username: string, password: string): Promise<AuthUser> {
  const res = await fetch(api('/api/auth/login'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await json<{ token: string; user: AuthUser }>(res);
  setToken(data.token);
  return data.user;
}

/** Validate the stored token and return the current user (or throw/null). */
export async function getMe(): Promise<AuthUser> {
  const data = await json<{ user: AuthUser }>(await authFetch('/api/auth/me'));
  return data.user;
}

/** Forget the stored token. */
export function logout(): void {
  setToken(null);
}

export async function getSources(): Promise<SourceInfo[]> {
  const data = await json<{ sources: SourceInfo[] }>(await authFetch('/api/sources'));
  return data.sources;
}

export async function getCountries(): Promise<Country[]> {
  const data = await json<{ countries: Country[] }>(await authFetch('/api/countries'));
  return data.countries;
}

/** Regions/states for a country (auto-fetched when a country is picked). */
export async function getRegions(countryCode: string): Promise<NamedCode[]> {
  const data = await json<{ regions: NamedCode[] }>(
    await authFetch(`/api/regions?country=${encodeURIComponent(countryCode)}`),
  );
  return data.regions;
}

/** Cities for a region (auto-fetched when a region is picked). */
export async function getCities(countryCode: string, regionCode: string): Promise<string[]> {
  const data = await json<{ cities: string[] }>(
    await authFetch(
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
    await authFetch('/api/jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

export async function cancelJob(id: string): Promise<void> {
  await authFetch(`/api/jobs/${id}/cancel`, { method: 'POST' });
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
  return json(await authFetch(`/api/jobs/${jobId}/leads?${params.toString()}`));
}

/**
 * Build the export path for a job (csv|xlsx), optionally for selected ids.
 * Relative (no base/token) — `downloadExport` runs it through `authFetch`.
 */
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
  const res = await authFetch(exportUrl(jobId, format, opts));
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
  // EventSource can't send an Authorization header, so the token goes in the
  // query string (the server also accepts `access_token` there).
  const token = getToken();
  const qs = token ? `?access_token=${encodeURIComponent(token)}` : '';
  const es = new EventSource(api(`/api/jobs/${jobId}/events${qs}`));
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
  return json(await authFetch('/api/import/avito/preview', { method: 'POST', body: fd }));
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
  return json(await authFetch('/api/import/avito', { method: 'POST', body: fd }));
}
