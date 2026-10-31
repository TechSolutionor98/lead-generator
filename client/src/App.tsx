import { useCallback, useEffect, useRef, useState } from 'react';
import type { Country, JobEvent, Lead, SourceInfo } from './types';
import {
  getSources,
  getCountries,
  createJob,
  cancelJob,
  getLeads,
  subscribeJob,
} from './api';
import SourcePanel, { type SearchConfig } from './components/SourcePanel';
import ProgressLog, { type LogLine } from './components/ProgressLog';
import ResultsTable from './components/ResultsTable';
import ExportBar from './components/ExportBar';
import AvitoImport from './components/AvitoImport';

const DEFAULT_QUERIES = [
  'компьютерный магазин',
  'системный интегратор',
  'сервисный центр компьютеров',
  'оптовая продажа комплектующих',
  'майнинг оборудование',
].join('\n');

const PAGE_SIZE = 50;

export default function App() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [countries, setCountries] = useState<Country[]>([]);
  const [config, setConfig] = useState<SearchConfig>({
    sources: [],
    targets: [
      { country: 'Russia', countryCode: 'ru', region: 'Москва', city: 'Москва' },
      { country: 'Russia', countryCode: 'ru', region: 'Санкт-Петербург', city: 'Санкт-Петербург' },
    ],
    queries: DEFAULT_QUERIES,
    limitPerQuery: 30,
    enrichEmail: false,
    delayMs: 0,
  });

  const [jobId, setJobId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [leadCount, setLeadCount] = useState(0);

  const [leads, setLeads] = useState<Lead[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  // Show everything — no individual/ИП filtering.
  const excludeIndividuals = false;
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const unsubRef = useRef<(() => void) | null>(null);
  const refetchTimer = useRef<number | null>(null);

  // Load available sources + regions once; default-select enabled sources.
  useEffect(() => {
    getSources()
      .then((s) => {
        setSources(s);
        const enabled = s.filter((x) => x.enabled && x.id !== 'avito').map((x) => x.id);
        setConfig((c) => ({ ...c, sources: enabled }));
      })
      .catch(() => undefined);
    getCountries().then(setCountries).catch(() => undefined);
  }, []);

  const refreshLeads = useCallback(
    async (id: string, p = page) => {
      try {
        const res = await getLeads(id, { page: p, pageSize: PAGE_SIZE, search, excludeIndividuals });
        setLeads(res.leads);
        setTotal(res.total);
      } catch {
        /* ignore transient */
      }
    },
    [page, search, excludeIndividuals],
  );

  // Re-fetch leads when filters/page change for the active job.
  useEffect(() => {
    if (jobId) void refreshLeads(jobId, page);
  }, [jobId, page, search, excludeIndividuals, refreshLeads]);

  const scheduleRefetch = useCallback(
    (id: string) => {
      if (refetchTimer.current) return; // throttle to ~1/s
      refetchTimer.current = window.setTimeout(() => {
        refetchTimer.current = null;
        void refreshLeads(id, 1);
      }, 1000);
    },
    [refreshLeads],
  );

  const onEvent = useCallback(
    (id: string, e: JobEvent) => {
      if (e.type === 'progress') {
        setProgress({ done: e.done, total: e.total });
        setLeadCount(e.counts.total);
        scheduleRefetch(id);
      } else if (e.type === 'log') {
        setLogs((prev) => [...prev.slice(-200), { level: e.level, message: e.message }]);
      } else if (e.type === 'lead') {
        setLeadCount((n) => n + 1);
        scheduleRefetch(id);
      } else if (e.type === 'done') {
        setLeadCount(e.counts.total);
        setRunning(false);
        setProgress((p) => ({ done: p.total || p.done, total: p.total || p.done }));
        void refreshLeads(id, 1);
        setPage(1);
      } else if (e.type === 'error') {
        setLogs((prev) => [...prev, { level: 'error', message: e.message }]);
        setRunning(false);
      }
    },
    [refreshLeads, scheduleRefetch],
  );

  const start = async () => {
    unsubRef.current?.();
    const queries = config.queries
      .split('\n')
      .map((q) => q.trim())
      .filter(Boolean);
    if (queries.length === 0) return;

    setLogs([]);
    setLeads([]);
    setTotal(0);
    setLeadCount(0);
    setProgress({ done: 0, total: 0 });
    setSelected(new Set());
    setPage(1);
    setRunning(true);

    try {
      const { id } = await createJob({
        sources: config.sources,
        queries,
        targets: config.targets,
        limitPerQuery: config.limitPerQuery,
        enrichEmail: config.enrichEmail,
        delayMs: config.delayMs,
      });
      setJobId(id);
      unsubRef.current = subscribeJob(id, (e) => onEvent(id, e));
    } catch (e) {
      setLogs([{ level: 'error', message: (e as Error).message }]);
      setRunning(false);
    }
  };

  const cancel = async () => {
    if (jobId) await cancelJob(jobId);
    setRunning(false);
  };

  const onAvitoImported = (id: string, inserted: number, parsed: number) => {
    setJobId(id);
    setRunning(false);
    setLogs((prev) => [
      ...prev,
      { level: 'info', message: `Avito import: ${inserted} inserted / ${parsed} parsed` },
    ]);
    setPage(1);
    void refreshLeads(id, 1);
  };

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="min-h-full bg-gray-50 text-gray-900 dark:bg-gray-950 dark:text-gray-100">
      {/* Header */}
      <header className="sticky top-0 z-20 border-b border-gray-200 bg-white/90 px-4 py-3 backdrop-blur dark:border-gray-800 dark:bg-gray-900/90">
        <div className="mx-auto flex max-w-7xl items-center justify-between">
          <div className="flex items-baseline gap-2.5">
            <span className="text-xl font-bold tracking-tight">
              Grab<span className="text-indigo-600 dark:text-indigo-400">Leads</span>
            </span>
            <span className="hidden text-xs text-gray-400 sm:inline">
              Russian B2B lead finder · for grabatoz.ae
            </span>
          </div>
          <span className="rounded-full border border-gray-200 px-2.5 py-0.5 text-[11px] text-gray-500 dark:border-gray-700 dark:text-gray-400">
            All results · no filtering
          </span>
        </div>
      </header>

      <main className="mx-auto grid max-w-7xl grid-cols-1 gap-5 p-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* Left: controls */}
        <aside className="flex flex-col gap-5">
          <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <SourcePanel
              sources={sources}
              countries={countries}
              config={config}
              onChange={setConfig}
              onStart={start}
              running={running}
              onCancel={cancel}
            />
          </div>
          <AvitoImport onImported={onAvitoImported} />
        </aside>

        {/* Right: progress + results */}
        <section className="flex flex-col gap-4">
          <ProgressLog
            done={progress.done}
            total={progress.total}
            running={running}
            logs={logs}
            leadCount={leadCount}
          />

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-gray-200 bg-white p-3 shadow-sm dark:border-gray-800 dark:bg-gray-900">
            <div className="flex flex-1 items-center gap-3">
              <div className="relative">
                <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400">
                  ⌕
                </span>
                <input
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value);
                    setPage(1);
                  }}
                  placeholder="Search leads…"
                  className="w-56 rounded-lg border border-gray-300 bg-white py-1.5 pl-7 pr-3 text-sm focus:border-indigo-500 focus:outline-none dark:border-gray-700 dark:bg-gray-800"
                />
              </div>
            </div>
            <ExportBar
              jobId={jobId}
              selectedIds={[...selected]}
              excludeIndividuals={excludeIndividuals}
              totalLeads={total}
            />
          </div>

          <ResultsTable leads={leads} selected={selected} onSelectedChange={setSelected} />

          {/* Pagination */}
          {total > PAGE_SIZE && (
            <div className="flex items-center justify-center gap-3 text-sm">
              <button
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page <= 1}
                className="rounded border border-gray-300 px-3 py-1 disabled:opacity-40 dark:border-gray-600"
              >
                Prev
              </button>
              <span className="text-gray-500">
                Page {page} / {totalPages} · {total} leads
              </span>
              <button
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page >= totalPages}
                className="rounded border border-gray-300 px-3 py-1 disabled:opacity-40 dark:border-gray-600"
              >
                Next
              </button>
            </div>
          )}
        </section>
      </main>

      <footer className="mx-auto max-w-7xl px-4 py-6 text-center text-xs text-gray-400">
        GrabLeads collects business contact data for outreach. Scraped sources are subject to their
        own Terms of Service — use responsibly. No captcha-solving, no personal-data harvesting.
      </footer>
    </div>
  );
}
