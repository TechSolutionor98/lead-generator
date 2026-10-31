import express from 'express';
import { env } from './env.js';
import { jobsRouter } from './routes/jobs.js';
import { importRouter } from './routes/import.js';
import { closeBrowser } from './browser.js';
import { usingProxy } from './http.js';
import { closeDb, connectAtStartup, isDbConfigured } from './mongo.js';

const app = express();

app.use(express.json({ limit: '2mb' }));

// Permissive CORS for local dev (Vite runs on a different port).
app.use((_req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (_req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    db: isDbConfigured() ? 'configured' : 'missing MONGODB_URI',
    proxy: usingProxy,
    headlessYandex: env.YANDEX_HEADLESS,
  });
});

app.use('/api', jobsRouter);
app.use('/api', importRouter);

// Centralized error handler (e.g. multer file-size errors).
app.use(
  (err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error('[error]', err.message);
    res.status(500).json({ error: err.message });
  },
);

const server = app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`\n[GrabLeads] API listening on http://localhost:${env.PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[GrabLeads] proxy: ${usingProxy ? 'on' : 'off'} · Yandex headless: ${env.YANDEX_HEADLESS}`);

  if (!isDbConfigured()) {
    // eslint-disable-next-line no-console
    console.warn(
      '[GrabLeads] ⚠️  MONGODB_URI is not set — the UI loads, but collecting/exporting\n' +
        '           will fail until you add your MongoDB Atlas connection string to .env.\n' +
        '           See README → "MongoDB setup".\n',
    );
  } else {
    // Connect eagerly so a bad URI / unreachable cluster shows up at boot.
    connectAtStartup()
      // eslint-disable-next-line no-console
      .then(() => console.log(`[GrabLeads] MongoDB connected (db: ${env.MONGODB_DB})\n`))
      .catch((err: Error) =>
        // eslint-disable-next-line no-console
        console.error(`[GrabLeads] ❌ MongoDB connection failed: ${err.message}\n`),
      );
  }
});

async function shutdown() {
  // eslint-disable-next-line no-console
  console.log('\n[GrabLeads] shutting down…');
  await closeBrowser();
  await closeDb().catch(() => undefined);
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
