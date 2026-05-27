import { Integration } from "@/backend/types";

interface IntegrationRegistryPanelProps {
  integrations: Integration[];
}

export default function IntegrationRegistryPanel({ integrations }: IntegrationRegistryPanelProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Integration Registry</h2>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {integrations.length} available
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {integrations.map((integration) => (
          <div key={integration.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
            <div className="flex items-start justify-between gap-3">
              <p className="font-medium text-slate-950 dark:text-slate-50">{integration.displayName}</p>
              <span className="rounded-md bg-white px-2 py-1 text-[11px] font-semibold uppercase text-slate-500 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-400 dark:ring-slate-800">
                {integration.authType}
              </span>
            </div>
            <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
              {integration.triggers.length} triggers · {integration.actions.length} actions
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
