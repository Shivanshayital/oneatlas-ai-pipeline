import { StageEvent } from "@/backend/types";

interface StageProgressPanelProps {
  events: StageEvent[];
  status: string;
}

const EVENT_LABELS: Record<string, string> = {
  stage_start: "Started",
  stage_complete: "Completed",
  stage_failed: "Failed",
  stage_retry: "Retry",
  generation_complete: "Finished",
};

export default function StageProgressPanel({ events, status }: StageProgressPanelProps) {
  return (
    <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-slate-900">Stage Progress</h2>
        <span className="rounded-full bg-slate-100 px-3 py-1 text-sm text-slate-700">
          {status}
        </span>
      </div>
      <div className="mt-4 space-y-3 text-sm text-slate-700">
        {events.length === 0 ? (
          <p>No pipeline events yet.</p>
        ) : (
          events.map((event, index) => (
            <div key={`${event.type}-${index}`} className="rounded-xl bg-slate-50 p-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-slate-900">
                    {EVENT_LABELS[event.type] ?? event.type} — {event.stage}
                  </p>
                  <p className="text-xs text-slate-500">{new Date(event.timestamp).toLocaleTimeString()}</p>
                </div>
                {event.error ? (
                  <span className="rounded-full bg-rose-100 px-2 py-1 text-xs font-semibold text-rose-700">
                    Error
                  </span>
                ) : null}
              </div>
              {event.data ? (
                <pre className="mt-3 overflow-x-auto rounded-md bg-slate-900 px-3 py-2 text-xs text-slate-100">
                  {JSON.stringify(event.data, null, 2)}
                </pre>
              ) : null}
              {event.error ? (
                <p className="mt-2 text-sm text-rose-700">{event.error}</p>
              ) : null}
            </div>
          ))
        )}
      </div>
    </section>
  );
}
