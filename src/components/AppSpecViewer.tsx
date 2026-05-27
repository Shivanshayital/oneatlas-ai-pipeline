import { AppSpec } from "@/backend/types";

interface AppSpecViewerProps {
  spec?: AppSpec;
}

export default function AppSpecViewer({ spec }: AppSpecViewerProps) {
  if (!spec) {
    return (
      <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-semibold text-slate-900">AppSpec Viewer</h2>
        <p className="mt-2 text-sm text-slate-600">Generated app specification will appear here after execution.</p>
      </section>
    );
  }

  return (
    <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-900">AppSpec Viewer</h2>
          <p className="mt-1 text-sm text-slate-600">Review the generated schema, pages, endpoints, and automation flows.</p>
        </div>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
          {spec.metadata.app_name}
        </span>
      </div>

      <div className="mt-5 space-y-6">
        <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Entities</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            {spec.data_schema.entities.map((entity) => (
              <div key={entity.name} className="rounded-xl bg-white p-3 shadow-sm">
                <p className="font-medium text-slate-900">{entity.name}</p>
                <p className="text-xs text-slate-500">{entity.tableName}</p>
                <div className="mt-3 space-y-2 text-sm text-slate-700">
                  {entity.fields.map((field) => (
                    <div key={field.name} className="flex items-center justify-between gap-2">
                      <span>{field.name}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-700">
                        {field.type}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Pages</h3>
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              {spec.pages.map((page) => (
                <div key={page.path} className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="font-medium text-slate-900">{page.title}</p>
                  <p className="text-xs text-slate-500">{page.path}</p>
                  <p className="mt-2 text-slate-600">Auth: {page.requires_auth ? "Required" : "Optional"}</p>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">API Endpoints</h3>
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              {spec.api_endpoints.map((endpoint) => (
                <div key={endpoint.path + endpoint.method} className="rounded-xl bg-white p-3 shadow-sm">
                  <p className="font-medium text-slate-900">{endpoint.method} {endpoint.path}</p>
                  <p className="text-xs text-slate-500">Entity: {endpoint.entity}</p>
                  <p className="mt-2 text-slate-600">Response: {endpoint.response_type}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Workflows</h3>
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              {spec.workflows.length === 0 ? (
                <p>No workflows generated.</p>
              ) : (
                spec.workflows.map((workflow) => (
                  <div key={workflow.name} className="rounded-xl bg-white p-3 shadow-sm">
                    <p className="font-medium text-slate-900">{workflow.name}</p>
                    <p className="text-xs text-slate-500">Trigger: {workflow.trigger_type}</p>
                    <p className="mt-2 text-slate-600">Entity: {workflow.trigger_entity}</p>
                  </div>
                ))
              )}
            </div>
          </div>

          <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-700">Integration Hooks</h3>
            <div className="mt-3 space-y-3 text-sm text-slate-700">
              {spec.integration_hooks.length === 0 ? (
                <p>No integration hooks configured.</p>
              ) : (
                spec.integration_hooks.map((hook) => (
                  <div key={`${hook.integration_id}-${hook.action}`} className="rounded-xl bg-white p-3 shadow-sm">
                    <p className="font-medium text-slate-900">{hook.integration_id}</p>
                    <p className="text-xs text-slate-500">Trigger: {hook.trigger}</p>
                    <p className="mt-2 text-slate-600">Action: {hook.action}</p>
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
