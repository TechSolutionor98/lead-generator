import { parse as parseCsv } from 'csv-parse/sync';
import { finalizeLead } from '../dedup.js';
import type { Lead, LeadSource, SearchParams } from '../types.js';

/**
 * Avito — manual import ONLY. Avito has no public business API and we do not
 * scrape it (no page scraping, no captcha). Instead the user exports a CSV/JSON
 * themselves (e.g. from their own Avito account / saved searches) and maps the
 * columns to Lead fields here.
 */

const SOURCE_ID = 'avito';

/** Maps uploaded column/field names → Lead fields. Values are source column keys. */
export interface AvitoMapping {
  name?: string;
  category?: string;
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  sourceUrl?: string;
}

type Row = Record<string, unknown>;

function parseFile(buffer: Buffer, filename: string): Row[] {
  const text = buffer.toString('utf-8').trim();
  const isJson = filename.toLowerCase().endsWith('.json') || text.startsWith('[') || text.startsWith('{');
  if (isJson) {
    const data = JSON.parse(text);
    if (Array.isArray(data)) return data as Row[];
    if (Array.isArray((data as { items?: Row[] }).items)) return (data as { items: Row[] }).items;
    return [data as Row];
  }
  // CSV / TSV — auto-detect the delimiter.
  const delimiter = text.includes('\t') && !text.includes(',') ? '\t' : ',';
  return parseCsv(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    delimiter,
    relax_column_count: true,
  }) as Row[];
}

/** Returns the column names present in the uploaded file (for the mapping UI). */
export function previewColumns(buffer: Buffer, filename: string): { columns: string[]; rowCount: number; sample: Row[] } {
  const rows = parseFile(buffer, filename);
  const columns = rows.length ? Object.keys(rows[0]) : [];
  return { columns, rowCount: rows.length, sample: rows.slice(0, 3) };
}

const str = (v: unknown): string | undefined => {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
};

/** Convert uploaded rows into Leads using the provided column mapping. */
export function importAvito(
  buffer: Buffer,
  filename: string,
  mapping: AvitoMapping,
  defaultCity: string,
): Lead[] {
  const rows = parseFile(buffer, filename);
  const leads: Lead[] = [];
  for (const row of rows) {
    const name = mapping.name ? str(row[mapping.name]) : undefined;
    if (!name) continue; // a lead must have a name
    leads.push(
      finalizeLead({
        source: SOURCE_ID,
        name,
        category: mapping.category ? str(row[mapping.category]) : undefined,
        phone: mapping.phone ? str(row[mapping.phone]) : undefined,
        email: mapping.email ? str(row[mapping.email]) : undefined,
        website: mapping.website ? str(row[mapping.website]) : undefined,
        address: mapping.address ? str(row[mapping.address]) : undefined,
        city: (mapping.city ? str(row[mapping.city]) : undefined) ?? defaultCity,
        sourceUrl: mapping.sourceUrl ? str(row[mapping.sourceUrl]) : undefined,
        collectedAt: new Date().toISOString(),
      }),
    );
  }
  return leads;
}

/** Import-only source: not part of live searches, so enabled() is false. */
export const avitoSource: LeadSource = {
  id: SOURCE_ID,
  name: 'Avito (manual import)',
  note: 'import CSV/JSON · no scraping',
  enabled: () => false,
  // eslint-disable-next-line require-yield
  async *search(_params: SearchParams): AsyncGenerator<Lead> {
    return; // live search is not supported for Avito
  },
};
