import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildXlsx, buildCsv, COLUMNS } from '../export.js';
import type { Lead } from '../types.js';

const leads: Lead[] = [
  {
    source: 'twogis',
    name: 'ООО Компьютеры',
    category: 'Компьютерный магазин',
    phone: '+74951234567',
    email: 'info@kompy.ru',
    website: 'https://kompy.ru',
    address: 'ул. Ленина, 1',
    city: 'Москва',
    lat: 55.75,
    lng: 37.62,
    rating: 4.7,
    reviewsCount: 120,
    sourceUrl: 'https://2gis.ru/firm/123',
    collectedAt: '2026-01-01T00:00:00.000Z',
    isIndividual: false,
  },
  {
    source: 'osm',
    name: 'Иван Петров',
    phone: '+79990001122',
    city: 'Казань',
    collectedAt: '2026-01-01T00:00:00.000Z',
    isIndividual: true,
  },
];

const PHONE_COL = COLUMNS.findIndex((c) => c.key === 'phone') + 1;
const WEBSITE_COL = COLUMNS.findIndex((c) => c.key === 'website') + 1;

describe('buildCsv', () => {
  it('produces a header + one row per lead', () => {
    const csv = buildCsv(leads);
    const lines = csv.trim().split('\n');
    expect(lines.length).toBe(leads.length + 1);
    expect(csv).toContain('Name');
    expect(csv).toContain('ООО Компьютеры');
    expect(csv).toContain('+74951234567');
  });
});

describe('buildXlsx', () => {
  it('builds a Leads + Summary workbook with the required formatting', async () => {
    const buf = await buildXlsx(leads);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);

    const ws = wb.getWorksheet('Leads');
    expect(ws).toBeTruthy();
    if (!ws) return;

    // Header is bold.
    expect(ws.getRow(1).font?.bold).toBe(true);

    // Top row is frozen.
    const view = ws.views?.[0] as { state?: string; ySplit?: number } | undefined;
    expect(view?.state).toBe('frozen');
    expect(view?.ySplit).toBe(1);

    // Autofilter spans the header.
    expect(ws.autoFilter).toBeTruthy();

    // Phone column is text-formatted and preserves the leading +7.
    const phoneCell = ws.getRow(2).getCell(PHONE_COL);
    expect(phoneCell.numFmt).toBe('@');
    expect(String(phoneCell.value)).toBe('+74951234567');

    // Website cell is a hyperlink.
    const siteCell = ws.getRow(2).getCell(WEBSITE_COL);
    expect((siteCell.value as { hyperlink?: string }).hyperlink).toBe('https://kompy.ru');

    // Summary sheet exists and tallies sources.
    const summary = wb.getWorksheet('Summary');
    expect(summary).toBeTruthy();
    let foundBySource = false;
    summary?.eachRow((row) => {
      if (String(row.getCell(1).value).includes('By Source')) foundBySource = true;
    });
    expect(foundBySource).toBe(true);
  });

  it('auto-sizes columns (widths are set)', async () => {
    const buf = await buildXlsx(leads);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as Parameters<typeof wb.xlsx.load>[0]);
    const ws = wb.getWorksheet('Leads');
    expect(ws?.getColumn(1).width).toBeGreaterThan(0);
  });
});
