import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { startJob, subscribe, getJob, cancelJob, isJobDone } from '../jobs.js';
import { queryLeads, countLeads } from '../db.js';
import { buildCsv, buildXlsx } from '../export.js';
import { sourceList } from '../sources/index.js';
import { listCountries, regionsFor, citiesFor } from '../locations.js';
import { DbNotConfiguredError } from '../mongo.js';
import type { JobEvent } from '../types.js';

export const jobsRouter = Router();

/**
 * Wrap an async handler so rejections become clean JSON responses instead of
 * unhandled promise rejections (Express 4 does not catch async errors itself).
 * A missing MongoDB config surfaces as a readable 503.
 */
function wrap(fn: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response): void => {
    fn(req, res).catch((err: unknown) => {
      if (err instanceof DbNotConfiguredError) {
        if (!res.headersSent) res.status(503).json({ error: err.message });
        return;
      }
      // eslint-disable-next-line no-console
      console.error('[route]', err);
      if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
    });
  };
}

// --- Validation -------------------------------------------------------------

const createJobSchema = z.object({
  sources: z.array(z.string().min(1)).min(1, 'pick at least one source'),
  queries: z.array(z.string().min(1)).min(1, 'enter at least one query'),
  targets: z
    .array(
      z.object({
        country: z.string().min(1),
        countryCode: z.string().min(2).max(2),
        region: z.string().min(1).optional(),
        city: z.string().min(1).optional(),
      }),
    )
    .min(1, 'pick at least one country, region or city'),
  limitPerQuery: z.coerce.number().int().min(1).max(10_000).default(50),
  enrichEmail: z.boolean().default(false),
  // Pause (ms) after each lead, to pace scraping. 0–60000.
  delayMs: z.coerce.number().int().min(0).max(60_000).default(0),
});

const leadsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(50),
  search: z.string().optional(),
  excludeIndividuals: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
});

const exportQuerySchema = z.object({
  format: z.enum(['csv', 'xlsx']).default('csv'),
  excludeIndividuals: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  // Selected-row ids are Mongo _id strings (dedup keys), comma-separated.
  ids: z
    .string()
    .optional()
    .transform((v) =>
      v
        ? v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    ),
});

// --- Routes -----------------------------------------------------------------

/** List available sources (for the UI checkboxes). */
jobsRouter.get('/sources', (_req, res) => {
  res.json({ sources: sourceList() });
});

/** All selectable countries ({ name, code }). */
jobsRouter.get('/countries', (_req, res) => {
  res.json({ countries: listCountries() });
});

/** Regions/states for a country: /api/regions?country=uz */
jobsRouter.get('/regions', (req, res) => {
  const country = typeof req.query.country === 'string' ? req.query.country : '';
  if (!country) {
    res.status(400).json({ error: 'country query param is required' });
    return;
  }
  res.json({ regions: regionsFor(country) });
});

/** Cities for a region: /api/cities?country=uz&region=<stateCode-or-name> */
jobsRouter.get('/cities', (req, res) => {
  const country = typeof req.query.country === 'string' ? req.query.country : '';
  const region = typeof req.query.region === 'string' ? req.query.region : '';
  if (!country || !region) {
    res.status(400).json({ error: 'country and region query params are required' });
    return;
  }
  res.json({ cities: citiesFor(country, region) });
});

/** Create a job and start processing. */
jobsRouter.post(
  '/jobs',
  wrap(async (req, res) => {
    const parsed = createJobSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid input', details: parsed.error.flatten() });
      return;
    }
    const job = await startJob(parsed.data);
    res.status(201).json({ id: job.id, status: job.status });
  }),
);

/** Job metadata (status + counts). */
jobsRouter.get(
  '/jobs/:id',
  wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    res.json({ ...job, live: !isJobDone(job.id) });
  }),
);

/** Cancel a running job. */
jobsRouter.post(
  '/jobs/:id/cancel',
  wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }
    cancelJob(job.id);
    res.json({ ok: true });
  }),
);

/** Server-Sent Events stream of job progress/logs/leads. */
jobsRouter.get(
  '/jobs/:id/events',
  wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders?.();

    const send = (e: JobEvent) => {
      res.write(`data: ${JSON.stringify(e)}\n\n`);
    };

    // Send current snapshot immediately.
    send({ type: 'progress', done: 0, total: 0, counts: job.counts });

    // If the job already finished, tell the client and close.
    if (isJobDone(job.id)) {
      send({ type: 'done', counts: job.counts });
      res.end();
      return;
    }

    const unsubscribe = subscribe(job.id, (e) => {
      send(e);
      if (e.type === 'done' || e.type === 'error') {
        unsubscribe();
        res.end();
      }
    });

    // Heartbeat so proxies don't drop the connection.
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }),
);

/** Paginated, deduplicated leads for a job. */
jobsRouter.get(
  '/jobs/:id/leads',
  wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const parsed = leadsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() });
      return;
    }
    const { page, pageSize, search, excludeIndividuals } = parsed.data;

    const total = await countLeads({ jobId: job.id, search, excludeIndividuals });
    const rows = await queryLeads({ jobId: job.id, search, excludeIndividuals, page, pageSize });

    res.json({
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
      leads: rows.map((r) => ({ id: r.id, ...r.lead })),
    });
  }),
);

/** Export a job's leads as CSV or XLSX (all rows, or selected ids). */
jobsRouter.get(
  '/jobs/:id/export',
  wrap(async (req, res) => {
    const job = await getJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: 'job not found' });
      return;
    }

    const parsed = exportQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid query', details: parsed.error.flatten() });
      return;
    }
    const { format, ids, excludeIndividuals } = parsed.data;

    const rows = await queryLeads({ jobId: job.id, excludeIndividuals, ids });
    const leads = rows.map((r) => r.lead);
    const stamp = new Date().toISOString().slice(0, 10);

    if (format === 'csv') {
      const csv = buildCsv(leads);
      res.set({
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="grableads-${stamp}.csv"`,
      });
      // UTF-8 BOM so Excel opens Cyrillic correctly.
      res.send('﻿' + csv);
      return;
    }

    const xlsx = await buildXlsx(leads);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="grableads-${stamp}.xlsx"`,
    });
    res.send(xlsx);
  }),
);
