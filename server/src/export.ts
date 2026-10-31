import ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import type { Lead } from './types.js';

/**
 * Export helpers. Column order is shared between CSV and XLSX for consistency.
 */

interface Column {
  key: keyof Lead;
  header: string;
  width: number;
}

const COLUMNS: Column[] = [
  { key: 'name', header: 'Name', width: 34 },
  { key: 'category', header: 'Category', width: 22 },
  { key: 'phone', header: 'Phone', width: 18 },
  { key: 'email', header: 'Email', width: 26 },
  { key: 'website', header: 'Website', width: 30 },
  { key: 'address', header: 'Address', width: 40 },
  { key: 'city', header: 'City', width: 18 },
  { key: 'source', header: 'Source', width: 12 },
  { key: 'rating', header: 'Rating', width: 9 },
  { key: 'reviewsCount', header: 'Reviews', width: 9 },
  { key: 'lat', header: 'Lat', width: 11 },
  { key: 'lng', header: 'Lng', width: 11 },
  { key: 'isIndividual', header: 'Individual', width: 11 },
  { key: 'sourceUrl', header: 'Source URL', width: 34 },
  { key: 'collectedAt', header: 'Collected At', width: 22 },
];

function cell(lead: Lead, key: keyof Lead): string | number | boolean | undefined {
  const v = lead[key];
  if (key === 'isIndividual') return v ? 'yes' : 'no';
  return v as string | number | boolean | undefined;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export function buildCsv(leads: Lead[]): string {
  const records = leads.map((l) => {
    const row: Record<string, unknown> = {};
    for (const col of COLUMNS) {
      // Prefix phone with a leading apostrophe-safe quote? csv keeps text as-is;
      // Excel may still auto-format, so we keep the full +7 string.
      row[col.header] = cell(l, col.key) ?? '';
    }
    return row;
  });
  return stringify(records, {
    header: true,
    columns: COLUMNS.map((c) => c.header),
    quoted: true,
  });
}

// ---------------------------------------------------------------------------
// XLSX
// ---------------------------------------------------------------------------

const PHONE_COL_INDEX = COLUMNS.findIndex((c) => c.key === 'phone') + 1; // 1-based
const WEBSITE_COL_INDEX = COLUMNS.findIndex((c) => c.key === 'website') + 1;

export async function buildXlsx(leads: Lead[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'GrabLeads';
  wb.created = new Date();

  // --- Leads sheet ---------------------------------------------------------
  const ws = wb.addWorksheet('Leads', {
    views: [{ state: 'frozen', ySplit: 1 }], // freeze header row
  });
  ws.columns = COLUMNS.map((c) => ({ header: c.header, key: c.header, width: c.width }));

  // Bold header row.
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.alignment = { vertical: 'middle' };

  // Force the phone column to be stored as text so +7… is not mangled.
  ws.getColumn(PHONE_COL_INDEX).numFmt = '@';

  for (const lead of leads) {
    const row = ws.addRow(
      COLUMNS.reduce<Record<string, unknown>>((acc, c) => {
        acc[c.header] = cell(lead, c.key) ?? '';
        return acc;
      }, {}),
    );
    // Phone as explicit text value.
    const phoneCell = row.getCell(PHONE_COL_INDEX);
    phoneCell.numFmt = '@';
    if (phoneCell.value != null) phoneCell.value = String(phoneCell.value);

    // Website as a clickable hyperlink.
    const site = lead.website;
    if (site) {
      const url = /^https?:\/\//.test(site) ? site : `https://${site}`;
      row.getCell(WEBSITE_COL_INDEX).value = { text: site, hyperlink: url };
      row.getCell(WEBSITE_COL_INDEX).font = { color: { argb: 'FF2563EB' }, underline: true };
    }
  }

  // Autofilter over the whole header row.
  ws.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: COLUMNS.length },
  };

  // --- Summary sheet -------------------------------------------------------
  const summary = wb.addWorksheet('Summary');
  buildSummarySheet(summary, leads);

  const buffer = await wb.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

function tally(leads: Lead[], key: (l: Lead) => string | undefined): [string, number][] {
  const map = new Map<string, number>();
  for (const l of leads) {
    const k = key(l) || '(не указано)';
    map.set(k, (map.get(k) ?? 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function buildSummarySheet(ws: ExcelJS.Worksheet, leads: Lead[]): void {
  ws.getColumn(1).width = 34;
  ws.getColumn(2).width = 12;

  const title = ws.addRow([`GrabLeads — ${leads.length} leads`]);
  title.font = { bold: true, size: 14 };
  ws.addRow([]);

  const section = (name: string, rows: [string, number][]) => {
    const head = ws.addRow([name, 'Count']);
    head.font = { bold: true };
    head.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFEFEF' } };
    });
    for (const [label, count] of rows) ws.addRow([label, count]);
    ws.addRow([]);
  };

  section('By Source', tally(leads, (l) => l.source));
  section('By City', tally(leads, (l) => l.city));
  section('By Category', tally(leads, (l) => l.category));
}

export { COLUMNS };
