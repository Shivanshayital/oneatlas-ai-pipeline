"use client";

import { useEffect, useRef, useState } from "react";
import PromptInput from "@/components/PromptInput";
import StageProgressPanel from "@/components/StageProgressPanel";
import AppSpecViewer from "@/components/AppSpecViewer";
import RepairLogPanel from "@/components/RepairLogPanel";
import IntegrationRegistryPanel from "@/components/IntegrationRegistryPanel";
import type {
  AppSpec,
  StageEvent,
  RepairLog,
  Integration,
  PipelineMetrics,
} from "@/backend/types";

export default function HomePage() {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [repairs, setRepairs] = useState<RepairLog[]>([]);
  const [spec, setSpec] = useState<AppSpec | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isExecuting, setIsExecuting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    fetch("/api/integrations")
      .then((response) => response.json())
      .then((data) => setIntegrations(data.integrations ?? []))
      .catch(() => {
        setIntegrations([]);
      });

    return () => {
      eventSourceRef.current?.close();
    };
  }, []);

  const fetchJobDetails = async (id: string) => {
    try {
      const response = await fetch(`/api/generate/${id}`);
      const data = await response.json();
      setStatus(String(data.status ?? "unknown"));
      setRepairs(Array.isArray(data.repairs) ? data.repairs : []);
      setMetrics(data.metrics ?? null);
      setSpec((data.result?.spec as AppSpec) ?? null);

      if (data.error) {
        setErrorMessage(String(data.error));
      }
    } catch (error) {
      setErrorMessage("Unable to load job details.");
    }
  };

  const subscribeToSse = (id: string) => {
    eventSourceRef.current?.close();
    const source = new EventSource(`/api/generate/${id}/stream`);
    eventSourceRef.current = source;

    source.addEventListener("message", (event) => {
      const payload = JSON.parse(event.data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
    });

    source.addEventListener("stage_start", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("running");
    });

    source.addEventListener("stage_complete", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("running");
    });

    source.addEventListener("stage_retry", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
    });

    source.addEventListener("stage_failed", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("failed");
      setErrorMessage(payload.error ?? "Stage failed");
      source.close();
    });

    source.addEventListener("generation_complete", async (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("completed");
      source.close();
      await fetchJobDetails(id);
    });

    source.onerror = () => {
      source.close();
      setTimeout(() => {
        if (eventSourceRef.current === source && status === "running") {
          subscribeToSse(id);
        }
      }, 1200);
    };
  };

  const handleSubmit = async (prompt: string) => {
    setErrorMessage(null);
    setIsExecuting(true);
    setEvents([]);
    setRepairs([]);
    setSpec(null);
    setMetrics(null);
    setStatus("pending");

    try {
      const response = await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
      });

      const data = await response.json();
      if (!response.ok || !data.job_id) {
        throw new Error(data.error ?? "Failed to start generation job");
      }

      setJobId(data.job_id);
      subscribeToSse(data.job_id);
    } catch (error) {
      setErrorMessage(String(error));
      setStatus("failed");
      setIsExecuting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 rounded-3xl border border-slate-200 bg-white p-6 shadow-sm">
          <h1 className="text-3xl font-semibold text-slate-900">OneAtlas AI Pipeline</h1>
          <p className="mt-2 text-slate-600">Generate app specifications with live progress tracking, repair visibility, and observable outputs.</p>
        </header>

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <PromptInput onSubmit={handleSubmit} disabled={isExecuting} />
            <StageProgressPanel events={events} status={status} />
            <AppSpecViewer spec={spec ?? undefined} />
          </div>

          <div className="space-y-6">
            <RepairLogPanel repairs={repairs} />
            <section className="rounded-xl border border-slate-300 bg-white p-5 shadow-sm">
              <h2 className="text-lg font-semibold text-slate-900">Execution Summary</h2>
              <div className="mt-4 space-y-3 text-sm text-slate-700">
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="font-medium text-slate-900">Job ID</p>
                  <p className="mt-1 text-slate-600">{jobId ?? "No job started"}</p>
                </div>
                <div className="rounded-xl bg-slate-50 p-3">
                  <p className="font-medium text-slate-900">Status</p>
                  <p className="mt-1 text-slate-600">{status}</p>
                </div>
                {metrics ? (
                  <div className="rounded-xl bg-slate-50 p-3">
                    <p className="font-medium text-slate-900">Estimated cost</p>
                    <p className="mt-1 text-slate-600">${metrics.tokens.estimated_cost.toFixed(4)}</p>
                  </div>
                ) : null}
              </div>
            </section>
            <IntegrationRegistryPanel integrations={integrations} />
          </div>
        </div>

        {errorMessage ? (
          <div className="mt-6 rounded-3xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700">
            <strong>Error:</strong> {errorMessage}
          </div>
        ) : null}
      </div>
    </main>
  );
}
