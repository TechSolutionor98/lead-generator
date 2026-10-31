import { useMemo, useState } from 'react';
import type { Lead } from '../types';

interface Props {
  leads: Lead[];
  selected: Set<string>;
  onSelectedChange: (next: Set<string>) => void;
}

type SortKey = keyof Lead;

const SOURCE_BADGE: Record<string, string> = {
  osm: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/50 dark:text-emerald-300',
  twogis: 'bg-sky-100 text-sky-700 dark:bg-sky-900/50 dark:text-sky-300',
  yandex: 'bg-red-100 text-red-700 dark:bg-red-900/50 dark:text-red-300',
  avito: 'bg-amber-100 text-amber-700 dark:bg-amber-900/50 dark:text-amber-300',
};

function CopyPhone({ phone }: { phone: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard?.writeText(phone).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
      title="Click to copy"
      className="group inline-flex items-center gap-1 font-mono text-xs text-gray-700 hover:text-indigo-600 dark:text-gray-200 dark:hover:text-indigo-400"
    >
      {phone}
      <span className={copied ? 'text-emerald-500' : 'text-gray-400 opacity-0 group-hover:opacity-100'}>
        {copied ? '✓' : '⧉'}
      </span>
    </button>
  );
}

function Rating({ value, count }: { value?: number; count?: number }) {
  if (value == null) return <span className="text-gray-300 dark:text-gray-600">—</span>;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="inline-flex items-center gap-0.5 rounded bg-amber-50 px-1.5 py-0.5 text-xs font-semibold text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
        ★ {value.toFixed(1)}
      </span>
      {count != null && <span className="text-[11px] text-gray-400">{count}</span>}
    </span>
  );
}

const COLS: { key: SortKey; label: string }[] = [
  { key: 'name', label: 'Name' },
  { key: 'category', label: 'Category' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'source', label: 'Source' },
  { key: 'rating', label: 'Rating' },
];

export default function ResultsTable({ leads, selected, onSelectedChange }: Props) {
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [asc, setAsc] = useState(true);

  const sorted = useMemo(() => {
    const copy = [...leads];
    copy.sort((a, b) => {
      const av = a[sortKey];
      const bv = b[sortKey];
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return asc ? av - bv : bv - av;
      return asc
        ? String(av).localeCompare(String(bv), 'ru')
        : String(bv).localeCompare(String(av), 'ru');
    });
    return copy;
  }, [leads, sortKey, asc]);

  const toggleSort = (key: SortKey) => {
    if (key === sortKey) setAsc(!asc);
    else {
      setSortKey(key);
      setAsc(true);
    }
  };

  const ids = leads.map((l) => l.id!).filter((x) => x != null);
  const allSelected = ids.length > 0 && ids.every((id) => selected.has(id));

  const toggleAll = () => onSelectedChange(allSelected ? new Set() : new Set(ids));
  const toggleOne = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  if (leads.length === 0) {
    return (
      <div className="flex h-56 flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 text-sm text-gray-400 dark:border-gray-700">
        <span className="text-3xl">🗂️</span>
        No leads yet — start a collection or import an Avito file.
      </div>
    );
  }

  const th =
    'cursor-pointer whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-gray-500 hover:text-indigo-600 dark:text-gray-400';
  const td = 'px-3 py-2.5 align-top';

  return (
    <div className="scroll-thin overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm dark:border-gray-800 dark:bg-gray-900">
      <table className="min-w-full border-collapse text-sm">
        <thead className="sticky top-0 z-10 border-b border-gray-200 bg-gray-50/95 backdrop-blur dark:border-gray-800 dark:bg-gray-900/95">
          <tr>
            <th className="w-10 px-3 py-2.5">
              <input
                type="checkbox"
                className="h-4 w-4 rounded text-indigo-600"
                checked={allSelected}
                onChange={toggleAll}
              />
            </th>
            {COLS.map((c) => (
              <th key={c.key} onClick={() => toggleSort(c.key)} className={th}>
                {c.label}
                <span className="ml-1 inline-block w-2 text-indigo-500">
                  {sortKey === c.key ? (asc ? '▲' : '▼') : ''}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100 dark:divide-gray-800">
          {sorted.map((l) => (
            <tr
              key={l.id}
              className={`transition-colors hover:bg-indigo-50/50 dark:hover:bg-gray-800/40 ${
                l.id != null && selected.has(l.id) ? 'bg-indigo-50/60 dark:bg-indigo-950/30' : ''
              }`}
            >
              <td className="px-3 py-2.5">
                <input
                  type="checkbox"
                  className="h-4 w-4 rounded text-indigo-600"
                  checked={l.id != null && selected.has(l.id)}
                  onChange={() => l.id != null && toggleOne(l.id)}
                />
              </td>
              <td className={`${td} min-w-[180px]`}>
                <div className="font-medium text-gray-900 dark:text-gray-100">{l.name}</div>
                {l.isIndividual && (
                  <span className="mt-0.5 inline-block rounded bg-amber-50 px-1.5 text-[10px] font-semibold uppercase text-amber-600 dark:bg-amber-900/40 dark:text-amber-400">
                    individual
                  </span>
                )}
              </td>
              <td className={`${td} text-gray-600 dark:text-gray-300`}>{l.category || '—'}</td>
              <td className={td}>
                {l.phone ? <CopyPhone phone={l.phone} /> : <span className="text-gray-300 dark:text-gray-600">—</span>}
              </td>
              <td className={td}>
                {l.email ? (
                  <a href={`mailto:${l.email}`} className="text-indigo-600 hover:underline dark:text-indigo-400">
                    {l.email}
                  </a>
                ) : (
                  <span className="text-gray-300 dark:text-gray-600">—</span>
                )}
              </td>
              <td className={`${td} max-w-[200px] truncate`}>
                {l.website ? (
                  <a
                    href={/^https?:\/\//.test(l.website) ? l.website : `https://${l.website}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-600 hover:underline dark:text-indigo-400"
                    title={l.website}
                  >
                    {l.website.replace(/^https?:\/\//, '').replace(/\/$/, '')}
                  </a>
                ) : (
                  <span className="text-gray-300 dark:text-gray-600">—</span>
                )}
              </td>
              <td className={`${td} max-w-[240px] truncate text-gray-600 dark:text-gray-300`} title={l.address}>
                {l.address || '—'}
              </td>
              <td className={`${td} whitespace-nowrap text-gray-600 dark:text-gray-300`}>{l.city}</td>
              <td className={td}>
                <span
                  className={`rounded-md px-2 py-0.5 text-[11px] font-semibold ${
                    SOURCE_BADGE[l.source] || 'bg-gray-100 text-gray-700'
                  }`}
                >
                  {l.source}
                </span>
              </td>
              <td className={td}>
                <Rating value={l.rating} count={l.reviewsCount} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
