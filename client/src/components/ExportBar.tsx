import { useState } from 'react';
import { downloadExport } from '../api';

interface Props {
  jobId: string | null;
  selectedIds: string[];
  excludeIndividuals: boolean;
  totalLeads: number;
  /** Called after a successful export so the view can drop the consumed leads. */
  onExported?: () => void;
}

/** CSV / Excel download buttons, for all rows or the current selection. */
export default function ExportBar({
  jobId,
  selectedIds,
  excludeIndividuals,
  totalLeads,
  onExported,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!jobId) return null;

  const hasSelection = selectedIds.length > 0;
  const download = async (format: 'csv' | 'xlsx', onlySelected: boolean) => {
    setError(null);
    setBusy(true);
    try {
      await downloadExport(jobId, format, {
        ids: onlySelected ? selectedIds : undefined,
        excludeIndividuals,
      });
      // Exported leads are now consumed server-side — refresh to drop them.
      onExported?.();
    } catch (e) {
      setError((e as Error).message || 'Download failed');
    } finally {
      setBusy(false);
    }
  };

  const btn =
    'rounded-md px-3 py-1.5 text-sm font-medium border transition disabled:opacity-40 disabled:cursor-not-allowed';

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-xs text-gray-500 dark:text-gray-400">
        Export {hasSelection ? `${selectedIds.length} selected` : `all ${totalLeads}`}:
      </span>
      <button
        onClick={() => download('csv', false)}
        disabled={totalLeads === 0 || busy}
        className={`${btn} border-gray-300 text-gray-700 hover:border-indigo-400 dark:border-gray-600 dark:text-gray-200`}
      >
        CSV (all)
      </button>
      <button
        onClick={() => download('xlsx', false)}
        disabled={totalLeads === 0 || busy}
        className={`${btn} border-green-600 bg-green-600 text-white hover:bg-green-700`}
      >
        {busy ? 'Preparing…' : 'Excel (all)'}
      </button>
      <button
        onClick={() => download('csv', true)}
        disabled={!hasSelection || busy}
        className={`${btn} border-gray-300 text-gray-700 hover:border-indigo-400 dark:border-gray-600 dark:text-gray-200`}
      >
        CSV (selected)
      </button>
      <button
        onClick={() => download('xlsx', true)}
        disabled={!hasSelection || busy}
        className={`${btn} border-green-600 text-green-700 hover:bg-green-50 dark:text-green-300 dark:hover:bg-green-900/30`}
      >
        Excel (selected)
      </button>
      {error && (
        <span className="w-full text-xs text-red-600 dark:text-red-400">
          {error} — try again, or use the CSV button.
        </span>
      )}
    </div>
  );
}
