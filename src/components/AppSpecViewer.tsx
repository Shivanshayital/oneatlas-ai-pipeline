import { AppSpec } from "@/backend/types";

interface AppSpecViewerProps {
  spec?: AppSpec;
}

const METHOD_STYLES: Record<string, string> = {
  GET: "bg-sky-50 text-sky-700 ring-sky-200 dark:bg-sky-950 dark:text-sky-300 dark:ring-sky-900",
  POST: "bg-emerald-50 text-emerald-700 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900",
  PUT: "bg-amber-50 text-amber-700 ring-amber-200 dark:bg-amber-950 dark:text-amber-300 dark:ring-amber-900",
  PATCH: "bg-violet-50 text-violet-700 ring-violet-200 dark:bg-violet-950 dark:text-violet-300 dark:ring-violet-900",
  DELETE: "bg-rose-50 text-rose-700 ring-rose-200 dark:bg-rose-950 dark:text-rose-300 dark:ring-rose-900",
};

function methodClass(method: string): string {
  return `rounded-md px-2 py-1 text-[11px] font-semibold ring-1 ${METHOD_STYLES[method] ?? METHOD_STYLES.GET}`;
}

export default function AppSpecViewer({ spec }: AppSpecViewerProps) {
  if (!spec) {
    return (
      <section className="rounded-xl border border-dashed border-slate-300 bg-white p-6 shadow-sm dark:border-slate-700 dark:bg-slate-950">
        <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">AppSpec Viewer</h2>
        <p className="mt-2 text-sm text-slate-500 dark:text-slate-400">
          Generated entities, endpoints, workflows, and integrations will appear here once a job completes.
        </p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">AppSpec Viewer</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
            {spec.metadata.app_name} · {spec.metadata.app_type}
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            {spec.data_schema.entities.length} entities
          </span>
          <span className="rounded-full bg-slate-100 px-3 py-1 font-semibold text-slate-600 dark:bg-slate-900 dark:text-slate-300">
            {spec.api_endpoints.length} endpoints
          </span>
        </div>
      </div>

      <div className="mt-6 space-y-6">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Entities</h3>
          <div className="mt-3 grid gap-3 lg:grid-cols-3">
            {spec.data_schema.entities.map((entity) => (
              <div key={entity.name} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-slate-950 dark:text-slate-50">{entity.name}</p>
                    <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{entity.tableName}</p>
                  </div>
                  <span className="rounded-md bg-white px-2 py-1 text-xs text-slate-500 ring-1 ring-slate-200 dark:bg-slate-950 dark:ring-slate-800">
                    {entity.fields.length}
                  </span>
                </div>
                <div className="mt-4 flex flex-wrap gap-2">
                  {entity.fields.slice(0, 6).map((field) => (
                    <span key={field.name} className="rounded-md bg-white px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                      {field.name}:{field.type}
                    </span>
                  ))}
                </div>
                {entity.relations.length > 0 ? (
                  <div className="mt-4 flex flex-wrap gap-2">
                    {entity.relations.slice(0, 3).map((relation) => (
                      <span key={relation.name} className="rounded-full bg-indigo-50 px-2.5 py-1 text-xs text-indigo-700 ring-1 ring-indigo-100 dark:bg-indigo-950 dark:text-indigo-300 dark:ring-indigo-900">
                        {relation.to_entity} · {relation.cardinality}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">API Endpoints</h3>
          <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 dark:border-slate-800">
            <div className="grid min-w-[560px] grid-cols-[90px_minmax(0,1fr)_120px_90px] bg-slate-50 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500 dark:bg-slate-900 dark:text-slate-400">
              <span>Method</span>
              <span>Path</span>
              <span>Entity</span>
              <span>Auth</span>
            </div>
            <div className="divide-y divide-slate-200 dark:divide-slate-800">
              {spec.api_endpoints.slice(0, 12).map((endpoint) => (
                <div key={`${endpoint.method}-${endpoint.path}`} className="grid min-w-[560px] grid-cols-[90px_minmax(0,1fr)_120px_90px] items-center gap-2 px-4 py-3 text-sm">
                  <span><span className={methodClass(endpoint.method)}>{endpoint.method}</span></span>
                  <span className="min-w-0 truncate font-mono text-xs text-slate-700 dark:text-slate-300">{endpoint.path}</span>
                  <span className="truncate text-slate-600 dark:text-slate-400">{endpoint.entity}</span>
                  <span className={endpoint.auth_required ? "text-emerald-700 dark:text-emerald-300" : "text-slate-400"}>
                    {endpoint.auth_required ? "yes" : "no"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Workflows</h3>
            <div className="mt-3 space-y-3">
              {spec.workflows.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400">
                  No workflows generated.
                </div>
              ) : (
                spec.workflows.map((workflow) => (
                  <div key={workflow.name} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div>
                        <p className="font-medium text-slate-950 dark:text-slate-50">{workflow.name}</p>
                        <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Entity: {workflow.trigger_entity}</p>
                      </div>
                      <span className="rounded-full bg-white px-3 py-1 text-xs font-semibold text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                        {workflow.trigger_type}
                      </span>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {workflow.steps.map((step, index) => (
                        <span key={`${workflow.name}-${index}`} className="rounded-md bg-white px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                          {step.integration_id ? `${step.integration_id}: ` : ""}{step.action}
                        </span>
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">Integration Hooks</h3>
            <div className="mt-3 space-y-3">
              {spec.integration_hooks.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-300 bg-slate-50 p-4 text-sm text-slate-500 dark:border-slate-700 dark:bg-slate-900/70 dark:text-slate-400">
                  No integration hooks configured for this spec.
                </div>
              ) : (
                spec.integration_hooks.map((hook) => (
                  <div key={`${hook.integration_id}-${hook.trigger}-${hook.action}`} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <p className="font-medium text-slate-950 dark:text-slate-50">{hook.integration_id}</p>
                      <span className="rounded-full bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 ring-1 ring-emerald-200 dark:bg-emerald-950 dark:text-emerald-300 dark:ring-emerald-900">
                        active
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2 text-sm text-slate-600 dark:text-slate-300">
                      <p><span className="text-slate-400">Trigger:</span> {hook.trigger}</p>
                      <p><span className="text-slate-400">Action:</span> {hook.action}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
