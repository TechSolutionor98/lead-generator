import { useState } from 'react';
import { previewAvito, importAvito, type AvitoPreview } from '../api';

interface Props {
  onImported: (jobId: string, inserted: number, parsed: number) => void;
}

// Lead fields the user maps their columns to. name is required.
const TARGET_FIELDS: { key: string; label: string; required?: boolean }[] = [
  { key: 'name', label: 'Name', required: true },
  { key: 'category', label: 'Category' },
  { key: 'phone', label: 'Phone' },
  { key: 'email', label: 'Email' },
  { key: 'website', label: 'Website' },
  { key: 'address', label: 'Address' },
  { key: 'city', label: 'City' },
  { key: 'sourceUrl', label: 'Source URL' },
];

// Guess a column for a target field by fuzzy header match (ru + en).
const HINTS: Record<string, RegExp> = {
  name: /назв|имя|компан|name|title|фирм/i,
  category: /категор|рубрик|тип|category/i,
  phone: /тел|phone|контакт/i,
  email: /mail|почт|email/i,
  website: /сайт|site|web|url(?!.*source)/i,
  address: /адрес|address|street|улиц/i,
  city: /город|city/i,
  sourceUrl: /ссылк|source|link|объявлен/i,
};

export default function AvitoImport({ onImported }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<AvitoPreview | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [city, setCity] = useState('Avito');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const autoMap = (columns: string[]): Record<string, string> => {
    const m: Record<string, string> = {};
    for (const field of Object.keys(HINTS)) {
      const col = columns.find((c) => HINTS[field].test(c));
      if (col) m[field] = col;
    }
    return m;
  };

  const handleFile = async (f: File) => {
    setError(null);
    setFile(f);
    setBusy(true);
    try {
      const p = await previewAvito(f);
      setPreview(p);
      setMapping(autoMap(p.columns));
    } catch (e) {
      setError((e as Error).message);
      setPreview(null);
    } finally {
      setBusy(false);
    }
  };

  const doImport = async () => {
    if (!file) return;
    if (!mapping.name) {
      setError('Please map the "Name" field — it is required.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await importAvito(file, mapping, city);
      onImported(res.id, res.inserted, res.parsed);
      setFile(null);
      setPreview(null);
      setMapping({});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-800">
      <h3 className="mb-1 text-sm font-semibold text-gray-700 dark:text-gray-200">
        Import Avito export (CSV / JSON)
      </h3>
      <p className="mb-3 text-xs text-gray-500 dark:text-gray-400">
        Avito has no business API and is not scraped. Export your own CSV/JSON and map its columns.
      </p>

      {!preview && (
        <label
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            const f = e.dataTransfer.files?.[0];
            if (f) void handleFile(f);
          }}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-md border-2 border-dashed p-6 text-center text-sm transition ${
            dragOver
              ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/30'
              : 'border-gray-300 text-gray-500 dark:border-gray-600'
          }`}
        >
          <span>{busy ? 'Reading…' : 'Drop a .csv / .json here, or click to choose'}</span>
          <input
            type="file"
            accept=".csv,.json,.tsv,text/csv,application/json"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
            }}
          />
        </label>
      )}

      {preview && (
        <div className="space-y-3">
          <div className="text-xs text-gray-500 dark:text-gray-400">
            {file?.name} · {preview.rowCount} rows · {preview.columns.length} columns
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {TARGET_FIELDS.map((f) => (
              <label key={f.key} className="flex items-center justify-between gap-2 text-sm">
                <span className="text-gray-600 dark:text-gray-300">
                  {f.label}
                  {f.required && <span className="text-red-500"> *</span>}
                </span>
                <select
                  value={mapping[f.key] || ''}
                  onChange={(e) =>
                    setMapping((m) => {
                      const next = { ...m };
                      if (e.target.value) next[f.key] = e.target.value;
                      else delete next[f.key];
                      return next;
                    })
                  }
                  className="w-40 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
                >
                  <option value="">—</option>
                  {preview.columns.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <label className="flex items-center justify-between gap-2 text-sm">
            <span className="text-gray-600 dark:text-gray-300">Default city (if no column)</span>
            <input
              value={city}
              onChange={(e) => setCity(e.target.value)}
              className="w-40 rounded border border-gray-300 bg-white px-2 py-1 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
            />
          </label>

          <div className="flex gap-2">
            <button
              onClick={doImport}
              disabled={busy}
              className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? 'Importing…' : 'Import'}
            </button>
            <button
              onClick={() => {
                setPreview(null);
                setFile(null);
              }}
              className="rounded-md border border-gray-300 px-3 py-1.5 text-sm dark:border-gray-600 dark:text-gray-200"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && <div className="mt-2 text-xs text-red-600 dark:text-red-400">{error}</div>}
    </div>
  );
}
