import { RepairLog } from "@/backend/types";

interface RepairLogPanelProps {
  repairs: RepairLog[];
}

export default function RepairLogPanel({ repairs }: RepairLogPanelProps) {
  return (
    <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-semibold text-slate-900">Repair Timeline</h2>
      <p className="mt-1 text-sm text-slate-600">
        A summary of repair activity applied while generating the AppSpec.
      </p>
      <div className="mt-4 space-y-3 text-sm text-slate-700">
        {repairs.length === 0 ? (
          <p>No repairs were required.</p>
        ) : (
          repairs.map((repair, index) => (
            <div key={`${repair.timestamp}-${index}`} className="rounded-xl bg-slate-50 p-3">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="font-medium text-slate-900">{repair.stage}</p>
                <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">
                  {repair.strategy}
                </span>
              </div>
              <p className="mt-2 text-sm text-slate-600">{repair.action}</p>
              <p className="mt-1 text-xs text-slate-500">{new Date(repair.timestamp).toLocaleString()}</p>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
