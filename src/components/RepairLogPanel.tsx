import { RepairLog } from "@/backend/types";
import type { ReactElement } from "react";

interface RepairLogPanelProps {
  repairs: RepairLog[];
}

interface RepairGroup {
  key: string;
  stage: string;
  strategy: string;
  outcome: "success" | "partial" | "failed";
  repairs: RepairLog[];
}

const STAGE_LABELS: Record<string, string> = {
  intent: "Intent repaired",
  schema: "Schema consistency repaired",
  spec: "AppSpec consistency repaired",
};

function groupRepairs(repairs: RepairLog[]): RepairGroup[] {
  const groups = new Map<string, RepairGroup>();

  for (const repair of repairs) {
    const key = `${repair.stage}-${repair.strategy}`;
    const existing = groups.get(key);
    if (existing) {
      existing.repairs.push(repair);
      if (repair.outcome === "failed") existing.outcome = "failed";
      if (repair.outcome === "partial" && existing.outcome === "success") existing.outcome = "partial";
      continue;
    }

    groups.set(key, {
      key,
      stage: repair.stage,
      strategy: repair.strategy,
      outcome: repair.outcome,
      repairs: [repair],
    });
  }

  return Array.from(groups.values());
}

function badgeClass(kind: "success" | "partial" | "failed" | "strategy"): string {
  const styles = {
    success: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
    partial: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
    failed: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
    strategy: "bg-slate-100 text-slate-600 ring-slate-200 dark:bg-slate-900 dark:text-slate-300 dark:ring-slate-800",
  };
  return `rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ring-1 ${styles[kind]}`;
}

export default function RepairLogPanel({ repairs }: RepairLogPanelProps): ReactElement {
  const groups = groupRepairs(repairs);

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Repair Timeline</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Grouped repairs keep model cleanup readable.</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {repairs.length}
        </span>
      </div>

      <div className="mt-5 space-y-3">
        {groups.length === 0 ? (
          <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400">
            No repairs recorded yet. If the model returns imperfect JSON, repair batches will appear here.
          </div>
        ) : (
          groups.map((group) => (
            <details key={group.key} className="group rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
              <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-3">
                <div>
                  <p className="font-medium text-slate-950 dark:text-slate-50">
                    {STAGE_LABELS[group.stage] ?? `${group.stage} repaired`}
                  </p>
                  <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                    {group.repairs.length} low-level {group.repairs.length === 1 ? "adjustment" : "adjustments"}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <span className={badgeClass(group.outcome)}>{group.outcome}</span>
                  <span className={badgeClass("strategy")}>{group.strategy.replace(/_/g, " ")}</span>
                </div>
              </summary>

              <div className="mt-4 space-y-2 border-t border-slate-200 pt-3 dark:border-slate-800">
                {group.repairs.map((repair, index) => (
                  <div key={`${repair.timestamp}-${index}`} className="rounded-lg bg-white px-3 py-2 text-sm ring-1 ring-slate-200 dark:bg-slate-950 dark:ring-slate-800">
                    <p className="text-slate-700 dark:text-slate-300">{repair.action}</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-500">{repair.error}</p>
                  </div>
                ))}
              </div>
            </details>
          ))
        )}
      </div>
    </section>
  );
}
