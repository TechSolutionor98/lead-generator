import { useEffect, useState } from 'react';
import type { Country, NamedCode, SourceInfo, Target } from '../types';
import { getRegions, getCities, estimateCounts, type EstimateResult } from '../api';

export interface SearchConfig {
  sources: string[];
  targets: Target[];
  queries: string; // textarea, one per line
  limitPerQuery: number;
  enrichEmail: boolean;
  delayMs: number; // pause after each lead
}

interface Props {
  sources: SourceInfo[];
  countries: Country[];
  config: SearchConfig;
  onChange: (c: SearchConfig) => void;
  onStart: () => void;
  running: boolean;
  onCancel: () => void;
}

const sameTarget = (a: Target, b: Target) =>
  a.country === b.country && (a.region ?? '') === (b.region ?? '') && (a.city ?? '') === (b.city ?? '');

const targetLabel = (t: Target) =>
  t.city ? t.city : t.region ? `${t.region} — whole region` : `${t.country} — whole country`;

export default function SourcePanel({
  sources,
  countries,
  config,
  onChange,
  onStart,
  running,
  onCancel,
}: Props) {
  const [countryName, setCountryName] = useState<string>('');
  const [regionOptions, setRegionOptions] = useState<NamedCode[]>([]);
  const [region, setRegion] = useState<NamedCode | null>(null);
  const [regionTyped, setRegionTyped] = useState(''); // free-text fallback when no regions in dataset
  const [cityOptions, setCityOptions] = useState<string[]>([]);
  const [loadingRegions, setLoadingRegions] = useState(false);
  const [loadingCities, setLoadingCities] = useState(false);

  // "Check available leads" estimate state.
  const [estimating, setEstimating] = useState(false);
  const [estimate, setEstimate] = useState<EstimateResult | null>(null);
  const [estimateError, setEstimateError] = useState<string | null>(null);

  // Default to the first country once the list loads.
  useEffect(() => {
    if (!countryName && countries.length) setCountryName(countries[0].name);
  }, [countries, countryName]);

  const country = countries.find((c) => c.name === countryName);

  // Auto-fetch regions whenever the country changes.
  useEffect(() => {
    if (!country) return;
    let cancelled = false;
    setLoadingRegions(true);
    setRegionOptions([]);
    setRegion(null);
    setRegionTyped('');
    setCityOptions([]);
    getRegions(country.code)
      .then((rs) => {
        if (!cancelled) setRegionOptions(rs);
      })
      .catch(() => {
        if (!cancelled) setRegionOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingRegions(false);
      });
    return () => {
      cancelled = true;
    };
  }, [country?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-fetch cities whenever a region is chosen.
  useEffect(() => {
    if (!country || !region || !region.code) {
      setCityOptions([]);
      return;
    }
    let cancelled = false;
    setLoadingCities(true);
    setCityOptions([]);
    getCities(country.code, region.code)
      .then((cs) => {
        if (!cancelled) setCityOptions(cs);
      })
      .catch(() => {
        if (!cancelled) setCityOptions([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingCities(false);
      });
    return () => {
      cancelled = true;
    };
  }, [country?.code, region?.code]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasRegions = regionOptions.length > 0;
  // The region name used for targets/geocoding (dropdown selection or typed fallback).
  const regionName = region?.name || regionTyped.trim();

  const toggleSource = (id: string) => {
    const has = config.sources.includes(id);
    onChange({
      ...config,
      sources: has ? config.sources.filter((s) => s !== id) : [...config.sources, id],
    });
  };

  const addTarget = (t: Target) => {
    if (config.targets.some((x) => sameTarget(x, t))) return;
    onChange({ ...config, targets: [...config.targets, t] });
  };
  const removeTarget = (t: Target) => {
    onChange({ ...config, targets: config.targets.filter((x) => !sameTarget(x, t)) });
  };
  const isSelected = (t: Target) => config.targets.some((x) => sameTarget(x, t));

  const liveSources = sources.filter((s) => s.id !== 'avito');

  // Build a Target at the current granularity.
  const mk = (opts: { region?: string; city?: string } = {}): Target => ({
    country: country?.name ?? countryName,
    countryCode: country?.code ?? '',
    region: opts.region || undefined,
    city: opts.city || undefined,
  });

  const delaySec = config.delayMs / 1000;

  // Ask the server how many leads are available per keyword, without collecting.
  const runEstimate = async () => {
    const queries = config.queries
      .split('\n')
      .map((q) => q.trim())
      .filter(Boolean);
    if (config.sources.length === 0 || config.targets.length === 0 || queries.length === 0) return;
    setEstimateError(null);
    setEstimate(null);
    setEstimating(true);
    try {
      const res = await estimateCounts({
        sources: config.sources,
        queries,
        targets: config.targets,
      });
      setEstimate(res);
    } catch (e) {
      setEstimateError((e as Error).message || 'Estimate failed');
    } finally {
      setEstimating(false);
    }
  };

  const fmt = (n: number | null) => (typeof n === 'number' ? n.toLocaleString() : 'n/a');

  return (
    <div className="flex flex-col gap-5">
      {/* Sources */}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Sources
        </h3>
        <div className="space-y-2">
          {liveSources.map((s) => (
            <label
              key={s.id}
              className={`flex items-start gap-2 rounded-md border p-2 text-sm ${
                s.enabled
                  ? 'border-gray-200 dark:border-gray-700'
                  : 'border-dashed border-gray-300 opacity-70 dark:border-gray-600'
              }`}
            >
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 rounded text-indigo-600"
                disabled={!s.enabled}
                checked={config.sources.includes(s.id)}
                onChange={() => toggleSource(s.id)}
              />
              <span>
                <span className="font-medium text-gray-800 dark:text-gray-100">{s.name}</span>
                {s.note && (
                  <span className="ml-1 text-xs text-gray-500 dark:text-gray-400">· {s.note}</span>
                )}
                {!s.enabled && (
                  <span className="ml-1 text-xs font-medium text-amber-600 dark:text-amber-400">
                    (add key, see README)
                  </span>
                )}
              </span>
            </label>
          ))}
        </div>
      </section>

      {/* Location: country → region → city */}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Location
        </h3>

        {/* Country */}
        <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">Country</label>
        <select
          value={countryName}
          onChange={(e) => setCountryName(e.target.value)}
          className="mb-3 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
        >
          {countries.map((c) => (
            <option key={c.code} value={c.name}>
              {c.name}
            </option>
          ))}
        </select>

        {country && (
          <>
            {/* Region / state — auto-fetched dropdown; free-text if the dataset has none */}
            <label className="mb-1 block text-xs font-medium text-gray-500 dark:text-gray-400">
              Region / state{' '}
              {loadingRegions && <span className="text-gray-400">· loading…</span>}
            </label>
            {hasRegions ? (
              <select
                value={region?.code ?? ''}
                onChange={(e) => {
                  const r = regionOptions.find((x) => x.code === e.target.value) ?? null;
                  setRegion(r);
                }}
                className="mb-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              >
                <option value="">— select a region ({regionOptions.length}) —</option>
                {regionOptions.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={regionTyped}
                onChange={(e) => setRegionTyped(e.target.value)}
                placeholder={loadingRegions ? 'loading…' : 'Type a region / state (optional)'}
                className="mb-2 w-full rounded-md border border-gray-300 bg-white px-2 py-1.5 text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
              />
            )}

            {/* Scope buttons */}
            <div className="mb-2 flex flex-col gap-1.5">
              <button
                type="button"
                onClick={() => addTarget(mk())}
                className={`w-full rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                  isSelected(mk())
                    ? 'border-amber-500 bg-amber-500 text-white'
                    : 'border-amber-400 text-amber-700 hover:bg-amber-50 dark:text-amber-300 dark:hover:bg-amber-900/30'
                }`}
              >
                + Whole country ({country.name})
              </button>
              {regionName && (
                <button
                  type="button"
                  onClick={() => addTarget(mk({ region: regionName }))}
                  className={`w-full rounded-md border px-3 py-1.5 text-xs font-medium transition ${
                    isSelected(mk({ region: regionName }))
                      ? 'border-emerald-500 bg-emerald-500 text-white'
                      : 'border-emerald-400 text-emerald-700 hover:bg-emerald-50 dark:text-emerald-300 dark:hover:bg-emerald-900/30'
                  }`}
                >
                  + Whole region ({regionName})
                </button>
              )}
            </div>

            {/* Auto-fetched cities for the chosen region */}
            {region && (
              <div className="mb-2">
                <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
                  Cities in {region.name}
                  {loadingCities && <span className="text-gray-400"> · loading…</span>}
                  {!loadingCities && cityOptions.length > 0 && (
                    <span className="text-gray-400"> · {cityOptions.length}</span>
                  )}
                </div>
                {!loadingCities && cityOptions.length === 0 ? (
                  <div className="text-xs text-gray-400">
                    No cities listed for this region — use “Whole region” instead.
                  </div>
                ) : (
                  <div className="flex max-h-44 flex-wrap gap-1.5 overflow-y-auto">
                    {cityOptions.map((c) => {
                      const t = mk({ region: regionName, city: c });
                      const active = isSelected(t);
                      return (
                        <button
                          key={c}
                          type="button"
                          onClick={() => (active ? removeTarget(t) : addTarget(t))}
                          className={`rounded-full border px-3 py-1 text-xs transition ${
                            active
                              ? 'border-indigo-500 bg-indigo-500 text-white'
                              : 'border-gray-300 text-gray-700 hover:border-indigo-400 dark:border-gray-600 dark:text-gray-300'
                          }`}
                        >
                          {c}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

          </>
        )}

        {/* Selected targets */}
        {config.targets.length > 0 && (
          <div className="mt-3">
            <div className="mb-1 text-xs font-medium text-gray-500 dark:text-gray-400">
              Searching ({config.targets.length}):
            </div>
            <div className="flex flex-wrap gap-1.5">
              {config.targets.map((t) => {
                const color = t.city
                  ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900 dark:text-indigo-200'
                  : t.region
                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900 dark:text-emerald-200'
                    : 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200';
                return (
                  <span
                    key={`${t.country}|${t.region ?? ''}|${t.city ?? ''}`}
                    className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-xs ${color}`}
                    title={[t.city, t.region, t.country].filter(Boolean).join(', ')}
                  >
                    {targetLabel(t)}
                    <span className="opacity-60">· {t.country}</span>
                    <button
                      onClick={() => removeTarget(t)}
                      className="ml-0.5 font-bold hover:text-red-600"
                      aria-label="remove"
                    >
                      ×
                    </button>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </section>

      {/* Queries */}
      <section>
        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
          Queries <span className="font-normal normal-case">(one per line)</span>
        </h3>
        <textarea
          rows={6}
          value={config.queries}
          onChange={(e) => onChange({ ...config, queries: e.target.value })}
          className="w-full resize-y rounded-md border border-gray-300 bg-white p-2 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          placeholder="компьютерный магазин"
        />
      </section>

      {/* Limit + delay + enrich */}
      <section className="space-y-3">
        <label className="flex items-center justify-between text-sm">
          <span className="text-gray-700 dark:text-gray-300">Limit per query / place</span>
          <input
            type="number"
            min={1}
            max={10000}
            value={config.limitPerQuery}
            onChange={(e) =>
              onChange({ ...config, limitPerQuery: Math.max(1, Number(e.target.value) || 1) })
            }
            className="w-20 rounded-md border border-gray-300 bg-white px-2 py-1 text-right text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>

        <label className="flex items-center justify-between text-sm">
          <span className="text-gray-700 dark:text-gray-300">
            Delay between leads
            <span className="ml-1 text-xs text-gray-400">(sec · 0 = none)</span>
          </span>
          <input
            type="number"
            min={0}
            max={60}
            step={0.5}
            value={delaySec}
            onChange={(e) =>
              onChange({ ...config, delayMs: Math.round(Math.max(0, Number(e.target.value) || 0) * 1000) })
            }
            className="w-20 rounded-md border border-gray-300 bg-white px-2 py-1 text-right text-sm dark:border-gray-600 dark:bg-gray-900 dark:text-gray-100"
          />
        </label>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-4 w-4 rounded text-indigo-600"
            checked={config.enrichEmail}
            onChange={(e) => onChange({ ...config, enrichEmail: e.target.checked })}
          />
          <span className="text-gray-700 dark:text-gray-300">
            Enrich email + phone from business websites
          </span>
        </label>
      </section>

      {/* Check available leads (estimate) */}
      <section className="space-y-2">
        <button
          type="button"
          onClick={runEstimate}
          disabled={
            estimating ||
            running ||
            config.sources.length === 0 ||
            config.targets.length === 0
          }
          className="w-full rounded-md border border-indigo-300 px-4 py-2 text-sm font-semibold text-indigo-700 hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-indigo-700 dark:text-indigo-300 dark:hover:bg-indigo-900/30"
        >
          {estimating ? 'Checking…' : '🔎 Check available leads'}
        </button>

        {estimateError && (
          <div className="rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/50 dark:text-red-300">
            {estimateError}
          </div>
        )}

        {estimate && (
          <div className="rounded-md border border-gray-200 bg-gray-50 p-3 text-xs dark:border-gray-700 dark:bg-gray-800/50">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold text-gray-700 dark:text-gray-200">
                Available (approx)
              </span>
              <span className="rounded-full bg-indigo-100 px-2 py-0.5 font-semibold text-indigo-700 dark:bg-indigo-900 dark:text-indigo-200">
                ~{fmt(estimate.grandTotal)} total
              </span>
            </div>
            <div className="mb-2 text-gray-400">
              across {estimate.places.length} place{estimate.places.length === 1 ? '' : 's'}:{' '}
              {estimate.places.join(', ') || '—'}
            </div>
            <div className="space-y-1.5">
              {estimate.queries.map((q) => (
                <div
                  key={q.query}
                  className="rounded border border-gray-200 bg-white px-2 py-1.5 dark:border-gray-700 dark:bg-gray-900"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate font-medium text-gray-800 dark:text-gray-100" title={q.query}>
                      {q.query}
                    </span>
                    <span className="shrink-0 font-semibold text-indigo-600 dark:text-indigo-300">
                      ~{fmt(q.total)}
                    </span>
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                    {q.sources.map((s) => (
                      <span key={s.sourceId}>
                        {s.name}: {s.supported ? fmt(s.count) : 'n/a'}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-2 text-[11px] leading-snug text-gray-400">
              {estimate.notes.map((n, i) => (
                <div key={i}>• {n}</div>
              ))}
            </div>
          </div>
        )}
      </section>

      {/* Start / Cancel */}
      {running ? (
        <button
          onClick={onCancel}
          className="rounded-md bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700"
        >
          Cancel
        </button>
      ) : (
        <button
          onClick={onStart}
          disabled={config.sources.length === 0 || config.targets.length === 0}
          className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Start collecting
        </button>
      )}
    </div>
  );
}
