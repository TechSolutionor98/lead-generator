import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { nanoid } from 'nanoid';
import { previewColumns, importAvito, type AvitoMapping } from '../sources/avito.js';
import {
  createJob,
  getJob,
  insertLead,
  computeCounts,
  saveJobCounts,
  setJobStatus,
} from '../db.js';
import { DbNotConfiguredError } from '../mongo.js';

export const importRouter = Router();

// In-memory upload, capped at 15 MB — these are user-exported lead files.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

const mappingSchema = z.object({
  name: z.string().optional(),
  category: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().optional(),
  website: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  sourceUrl: z.string().optional(),
});

/** Step 1: inspect an uploaded file and return its columns for mapping. */
importRouter.post('/import/avito/preview', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
  try {
    const { columns, rowCount, sample } = previewColumns(req.file.buffer, req.file.originalname);
    res.json({ columns, rowCount, sample });
  } catch (err) {
    res.status(400).json({ error: `could not parse file: ${(err as Error).message}` });
  }
});

/** Step 2: import rows into a (new or existing) job using the column mapping. */
importRouter.post('/import/avito', upload.single('file'), (req, res) => {
  void handleImport(req, res).catch((err: unknown) => {
    if (err instanceof DbNotConfiguredError) {
      if (!res.headersSent) res.status(503).json({ error: err.message });
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[import]', err);
    if (!res.headersSent) res.status(500).json({ error: (err as Error).message });
  });
});

async function handleImport(req: Request, res: Response): Promise<void> {
  if (!req.file) {
    res.status(400).json({ error: 'no file uploaded' });
    return;
  }

  let mapping: AvitoMapping;
  try {
    const raw = typeof req.body.mapping === 'string' ? JSON.parse(req.body.mapping) : req.body.mapping;
    const parsed = mappingSchema.safeParse(raw);
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid mapping', details: parsed.error.flatten() });
      return;
    }
    mapping = parsed.data;
  } catch {
    res.status(400).json({ error: 'mapping must be valid JSON' });
    return;
  }

  if (!mapping.name) {
    res.status(400).json({ error: 'mapping.name is required (which column holds the business name)' });
    return;
  }

  const defaultCity = typeof req.body.city === 'string' && req.body.city.trim() ? req.body.city.trim() : 'Avito';
  const jobId = typeof req.body.jobId === 'string' && req.body.jobId ? req.body.jobId : nanoid(12);

  // Create the job row if it doesn't already exist.
  if (!(await getJob(jobId))) {
    await createJob(jobId, {
      sources: ['avito'],
      queries: ['(import)'],
      targets: [{ country: defaultCity, countryCode: '', city: defaultCity }],
      limitPerQuery: 0,
      enrichEmail: false,
      delayMs: 0,
    });
  }

  let leads;
  try {
    leads = importAvito(req.file.buffer, req.file.originalname, mapping, defaultCity);
  } catch (err) {
    await setJobStatus(jobId, 'error', (err as Error).message);
    res.status(400).json({ error: `import failed: ${(err as Error).message}` });
    return;
  }

  let inserted = 0;
  for (const lead of leads) {
    if (await insertLead(jobId, lead)) inserted += 1;
  }
  const counts = await computeCounts(jobId);
  await saveJobCounts(jobId, counts);
  await setJobStatus(jobId, 'done');

  res.status(201).json({ id: jobId, parsed: leads.length, inserted, counts });
}
