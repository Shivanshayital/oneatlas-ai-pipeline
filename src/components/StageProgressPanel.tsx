import { StageEvent, PipelineStage, ProviderUsage } from "@/backend/types";

interface StageProgressPanelProps {
  events: StageEvent[];
  status: string;
  providerHistory?: ProviderUsage[];
}

const STAGES: Array<{ id: PipelineStage; label: string }> = [
  { id: "intent", label: "Intent Extraction" },
  { id: "schema", label: "Schema Generation" },
  { id: "spec", label: "AppSpec Generation" },
];

function formatDuration(ms?: number): string {
  if (!ms) return "--";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function stageState(stage: PipelineStage, events: StageEvent[], status: string, providerHistory?: ProviderUsage[]) {
  const stageEvents = events.filter((event) => event.stage === stage);
  const started = stageEvents.find((event) => event.type === "stage_start");
  const completed = [...stageEvents].reverse().find((event) => event.type === "stage_complete");
  const failed = [...stageEvents].reverse().find((event) => event.type === "stage_failed");
  const providerEvent = stageEvents.find((event) => event.data?.provider || event.data?.model);
  const latestUsage = providerHistory?.filter((u) => u.stage === stage).at(-1);

  const startedAt = started ? new Date(started.timestamp).getTime() : undefined;
  const endedAt = completed
    ? new Date(completed.timestamp).getTime()
    : failed
      ? new Date(failed.timestamp).getTime()
      : undefined;

  const state = failed
    ? "failed"
    : completed
      ? "complete"
      : started || status === "running"
        ? "running"
        : "pending";

  return {
    state,
    duration: startedAt && endedAt ? endedAt - startedAt : undefined,
    provider: providerEvent?.data?.provider ? String(providerEvent.data.provider) : latestUsage?.provider,
    model: providerEvent?.data?.model ? String(providerEvent.data.model) : latestUsage?.model,
    tokens: latestUsage?.tokens_normalized,
    error: failed?.error,
  };
}

function stateBadge(state: string) {
  const styles: Record<string, string> = {
    complete: "border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900/60 dark:bg-emerald-950 dark:text-emerald-300",
    running: "border-sky-200 bg-sky-50 text-sky-700 dark:border-sky-900/60 dark:bg-sky-950 dark:text-sky-300",
    failed: "border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-900/60 dark:bg-rose-950 dark:text-rose-300",
    pending: "border-slate-200 bg-slate-50 text-slate-500 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-400",
  };

  const label: Record<string, string> = {
    complete: "OK",
    running: "RUN",
    failed: "ERR",
    pending: "--",
  };

  return (
    <span className={`inline-flex h-7 w-9 items-center justify-center rounded-full border text-[11px] font-semibold ${styles[state]}`}>
      {label[state]}
    </span>
  );
}

export default function StageProgressPanel({ events, status, providerHistory }: StageProgressPanelProps) {
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Stage Progress</h2>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Live execution state from intent to final AppSpec.</p>
        </div>
        <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
          {status}
        </span>
      </div>

      <div className="mt-5 grid gap-3">
        {STAGES.map((stage) => {
          const current = stageState(stage.id, events, status, providerHistory);
          return (
            <div key={stage.id} className="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-800 dark:bg-slate-900/70">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-3">
                  {stateBadge(current.state)}
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="font-medium text-slate-950 dark:text-slate-50">{stage.label}</p>
                      <span className="text-xs text-slate-500 dark:text-slate-400">{formatDuration(current.duration)}</span>
                    </div>
                    {current.provider || current.model ? (
                      <div className="mt-2 flex flex-wrap gap-2">
                        {current.provider ? (
                          <span className="rounded-md bg-white px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                            {current.provider}
                          </span>
                        ) : null}
                        {current.model ? (
                          <span className="max-w-full truncate rounded-md bg-white px-2 py-1 text-xs text-slate-600 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300 dark:ring-slate-800">
                            {current.model}
                          </span>
                        ) : null}
                      </div>
                    ) : (
                      <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">Waiting for execution.</p>
                    )}
                    {current.tokens ? (
                      <div className="mt-3 flex items-center gap-2">
                        <span className="rounded-md bg-white px-2 py-1 text-xs font-mono text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300">P:{current.tokens.promptTokens}</span>
                        <span className="rounded-md bg-white px-2 py-1 text-xs font-mono text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300">C:{current.tokens.completionTokens}</span>
                        <span className="rounded-md bg-white px-2 py-1 text-xs font-mono text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300">T:{current.tokens.totalTokens}</span>
                        <span className="rounded-md bg-white px-2 py-1 text-xs font-mono text-slate-700 ring-1 ring-slate-200 dark:bg-slate-950 dark:text-slate-300">${current.tokens.estimatedCost.toFixed(4)}</span>
                      </div>
                    ) : null}
                  </div>
                </div>
              </div>
              {current.error ? (
                <p className="mt-3 rounded-lg border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950 dark:text-rose-300">
                  {current.error}
                </p>
              ) : null}
            </div>
          );
        })}
      </div>
    </section>
  );
}
