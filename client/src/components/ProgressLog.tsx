import { useEffect, useRef, useState } from 'react';

export interface LogLine {
  level: 'info' | 'warn' | 'error' | 'captcha';
  message: string;
}

interface Props {
  done: number;
  total: number;
  running: boolean;
  logs: LogLine[];
  leadCount: number;
}

const levelColor: Record<LogLine['level'], string> = {
  info: 'text-gray-500 dark:text-gray-400',
  warn: 'text-amber-600 dark:text-amber-400',
  error: 'text-red-600 dark:text-red-400',
  captcha: 'text-fuchsia-600 dark:text-fuchsia-400 font-semibold',
};

export default function ProgressLog({ done, total, running, logs, leadCount }: Props) {
  const pct = total > 0 ? Math.round((done / total) * 100) : running ? 6 : 0;
  const [open, setOpen] = useState(true);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) endRef.current?.scrollIntoView({ block: 'nearest' });
  }, [logs.length, open]);

  const status = running ? 'Collecting' : total > 0 ? 'Finished' : 'Idle';
  const statusStyle = running
    ? 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/60 dark:text-indigo-300'
    : total > 0
      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/60 dark:text-emerald-300'
      : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400';

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span
            className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold ${statusStyle}`}
          >
            {running && (
              <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-indigo-500 dark:bg-indigo-400" />
            )}
            {status}
          </span>
          <span className="text-2xl font-bold tabular-nums text-gray-900 dark:text-gray-50">
            {leadCount}
          </span>
          <span className="text-sm text-gray-500 dark:text-gray-400">leads</span>
        </div>
        <div className="flex items-center gap-3 text-xs text-gray-500 dark:text-gray-400">
          <span className="tabular-nums">
            {done}/{total} tasks
          </span>
          {logs.length > 0 && (
            <button
              onClick={() => setOpen((o) => !o)}
              className="rounded-md border border-gray-200 px-2 py-0.5 hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
            >
              {open ? 'Hide log' : 'Show log'}
            </button>
          )}
        </div>
      </div>

      <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-800">
        <div
          className={`h-full rounded-full transition-all duration-500 ${
            running ? 'bg-indigo-500' : 'bg-emerald-500'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>

      {open && logs.length > 0 && (
        <div className="scroll-thin mt-3 max-h-36 overflow-y-auto rounded-lg bg-gray-50 p-3 font-mono text-[11px] leading-relaxed dark:bg-gray-950/60">
          {logs.map((l, i) => (
            <div key={i} className={levelColor[l.level]}>
              {l.level === 'captcha' ? '🧩 ' : l.level === 'error' ? '✕ ' : ''}
              {l.message}
            </div>
          ))}
          <div ref={endRef} />
        </div>
      )}
    </div>
  );
}
