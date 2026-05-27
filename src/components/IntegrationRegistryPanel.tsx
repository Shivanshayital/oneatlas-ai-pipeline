import { Integration } from "@/backend/types";

interface IntegrationRegistryPanelProps {
  integrations: Integration[];
}

export default function IntegrationRegistryPanel({ integrations }: IntegrationRegistryPanelProps) {
  return (
    <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-semibold text-slate-900">Integration Registry</h2>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
          {integrations.length} available
        </span>
      </div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {integrations.map((integration) => (
          <div key={integration.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <p className="font-medium text-slate-900">{integration.displayName}</p>
            <p className="mt-1 text-sm text-slate-600">{integration.authType}</p>
            <p className="mt-2 text-xs text-slate-500">{integration.documentationUrl ?? "No docs provided"}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
