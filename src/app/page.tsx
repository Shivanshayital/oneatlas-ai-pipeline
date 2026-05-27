"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import PromptInput from "@/components/PromptInput";
import StageProgressPanel from "@/components/StageProgressPanel";
import AppSpecViewer from "@/components/AppSpecViewer";
import RepairLogPanel from "@/components/RepairLogPanel";
import ProviderUsageDashboard from "@/components/ProviderUsageDashboard";
import IntegrationRegistryPanel from "@/components/IntegrationRegistryPanel";
import type {
  AppSpec,
  StageEvent,
  RepairLog,
  Integration,
  PipelineMetrics,
  ProviderUsageSummary,
  ProviderUsage,
  AIProvider,
} from "@/backend/types";

export default function HomePage(): ReactElement {
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState("idle");
  const [events, setEvents] = useState<StageEvent[]>([]);
  const [repairs, setRepairs] = useState<RepairLog[]>([]);
  const [spec, setSpec] = useState<AppSpec | null>(null);
  const [integrations, setIntegrations] = useState<Integration[]>([]);
  const [metrics, setMetrics] = useState<PipelineMetrics | null>(null);
  const [providerHistory, setProviderHistory] = useState<ProviderUsage[]>([]);
  const [providerUsageSummary, setProviderUsageSummary] = useState<ProviderUsageSummary | null>(null);
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

  const fetchJobDetails = async (id: string): Promise<void> => {
    try {
      const response = await fetch(`/api/generate/${id}`);
      const data = await response.json();
      setStatus(String(data.status ?? "unknown"));
      setRepairs(Array.isArray(data.repairs) ? data.repairs : []);
      setMetrics(data.metrics ?? null);
      setProviderHistory(Array.isArray(data.provider_history) ? data.provider_history : []);
      setProviderUsageSummary(data.provider_usage_summary ?? null);
      setSpec((data.result?.spec as AppSpec) ?? null);

      if (data.error) {
        setErrorMessage(String(data.error));
      }
    } catch (error) {
      setErrorMessage("Unable to load job details.");
    }
  };

  const subscribeToSse = (id: string): void => {
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
      if (payload.latency_ms) {
        setMetrics((prev) => {
          const next = prev ?? emptyMetrics();
          const latency = { ...next.latency };
          if (payload.stage === "intent") latency.intent_stage_ms = payload.latency_ms ?? 0;
          if (payload.stage === "schema") latency.schema_stage_ms = payload.latency_ms ?? 0;
          if (payload.stage === "spec") latency.spec_stage_ms = payload.latency_ms ?? 0;
          latency.total_ms = latency.intent_stage_ms + latency.schema_stage_ms + latency.spec_stage_ms;
          return { ...next, latency };
        });
      }
    });

    source.addEventListener("stage_retry", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
    });

    source.addEventListener("stage_provider_usage", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      // Append provider usage to local history for live UI updates
      const providerUsage = payload.data?.provider_usage as ProviderUsage | undefined;
      if (providerUsage) {
        setProviderHistory((prev) => [...prev, providerUsage]);
        setMetrics((prev) => addUsageToMetrics(prev, providerUsage));
      }
    });

    source.addEventListener("stage_failed", (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("failed");
      setErrorMessage(payload.error ?? "Stage failed");
      setIsExecuting(false);
      source.close();
    });

    source.addEventListener("generation_complete", async (event) => {
      const payload = JSON.parse((event as MessageEvent).data) as StageEvent;
      setEvents((prev) => [...prev, payload]);
      setStatus("completed");
      setIsExecuting(false);
      source.close();
      await fetchJobDetails(id);
    });

    source.onerror = () => {
      source.close();
      setTimeout(() => {
        if (eventSourceRef.current === source && status === "running") {
          subscribeToSse(id);
        } else if (status !== "running") {
          setIsExecuting(false);
        }
      }, 1200);
    };
  };

  const handleSubmit = async (prompt: string): Promise<void> => {
    setErrorMessage(null);
    setIsExecuting(true);
    setEvents([]);
    setRepairs([]);
    setSpec(null);
    setMetrics(null);
    setProviderHistory([]);
    setProviderUsageSummary(null);
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
      setProviderUsageSummary(createProviderSummary(data.available_providers));
      subscribeToSse(data.job_id);
    } catch (error) {
      setErrorMessage(String(error));
      setStatus("failed");
      setIsExecuting(false);
    }
  };

  return (
    <main className="min-h-screen bg-slate-100 px-4 py-6 text-slate-950 dark:bg-slate-950 dark:text-slate-50 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-6 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h1 className="text-2xl font-semibold text-slate-950 dark:text-slate-50">OneAtlas AI Pipeline</h1>
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Operational view for prompt-to-AppSpec generation, validation, and repair.</p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold uppercase tracking-wide text-slate-600 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-300">
              {status}
            </span>
          </div>
        </header>

        <div className="grid gap-6 xl:grid-cols-[1.5fr_1fr]">
          <div className="space-y-6">
            <PromptInput onSubmit={handleSubmit} disabled={isExecuting} />
            <StageProgressPanel events={events} status={status} providerHistory={providerHistory} />
            <AppSpecViewer spec={spec ?? undefined} />
            <RepairLogPanel repairs={repairs} />
          </div>

          <div className="space-y-6">
            <ProviderUsageDashboard providerUsageSummary={providerUsageSummary} providerHistory={providerHistory} />
            <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
              <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Execution Summary</h2>
              <div className="mt-4 grid gap-3 text-sm sm:grid-cols-2 xl:grid-cols-1">
                <SummaryItem label="Job ID" value={jobId ?? "No job started"} mono />
                <SummaryItem label="Status" value={status} />
                <SummaryItem label="Total latency" value={metrics ? `${(metrics.latency.total_ms / 1000).toFixed(1)}s` : "--"} />
                <SummaryItem label="Repairs" value={String(repairs.length)} />
                <SummaryItem label="Cost" value={metrics ? `$${metrics.tokens.estimated_cost.toFixed(4)}` : "--"} />
                <SummaryItem label="Tokens" value={metrics ? metrics.tokens.total_tokens.toLocaleString() : "--"} />
                <SummaryItem label="Prompt" value={metrics ? String(metrics.tokens.input_tokens) : "--"} mono />
                <SummaryItem label="Completion" value={metrics ? String(metrics.tokens.output_tokens) : "--"} mono />
                <SummaryItem label="Fallback used" value={providerHistory.some((usage) => usage.attempt > 1) ? "yes" : "no"} />
                <SummaryItem label="Latency" value={providerHistory.at(-1) ? `${providerHistory.at(-1)?.latency_ms.toFixed(0)}ms` : "--"} />
                <SummaryItem
                  label="Provider"
                  value={providerHistory.at(-1)?.provider ?? "--"}
                />
                <SummaryItem
                  label="Model"
                  value={providerHistory.at(-1)?.model ?? "--"}
                  mono
                />
              </div>
            </section>
            <IntegrationRegistryPanel integrations={integrations} />
          </div>
        </div>

        {errorMessage ? (
          <div className="mt-6 rounded-xl border border-rose-200 bg-rose-50 p-5 text-sm text-rose-700 dark:border-rose-900/60 dark:bg-rose-950 dark:text-rose-300">
            <strong>Error:</strong> {errorMessage}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function emptyMetrics(): PipelineMetrics {
  return {
    tokens: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      estimated_cost: 0,
    },
    latency: {
      intent_stage_ms: 0,
      schema_stage_ms: 0,
      spec_stage_ms: 0,
      total_ms: 0,
    },
    repair_attempts: 0,
    successful_repairs: 0,
  };
}

function addUsageToMetrics(
  metrics: PipelineMetrics | null,
  usage: ProviderUsage
): PipelineMetrics {
  const next = metrics ?? emptyMetrics();
  return {
    ...next,
    tokens: {
      input_tokens: next.tokens.input_tokens + usage.tokens.input_tokens,
      output_tokens: next.tokens.output_tokens + usage.tokens.output_tokens,
      total_tokens: next.tokens.total_tokens + usage.tokens.total_tokens,
      estimated_cost: next.tokens.estimated_cost + usage.tokens.estimated_cost,
    },
  };
}

function createProviderSummary(providers: unknown): ProviderUsageSummary {
  const configured = new Set(
    Array.isArray(providers) ? providers.map((provider) => String(provider)) : []
  );
  const allProviders: AIProvider[] = [
    "gemini",
    "deepseek",
    "groq",
    "openai",
    "anthropic",
    "mistral",
    "openrouter",
  ];

  return allProviders.reduce((summary, provider) => {
    summary[provider] = {
      provider,
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      status: configured.has(provider) ? "healthy" : "inactive",
      estimatedRemainingQuota: 0,
      quotaStatus: "unknown",
      failures: 0,
    };
    return summary;
  }, {} as ProviderUsageSummary);
}

function SummaryItem({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): ReactElement {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-slate-800 dark:bg-slate-900/70">
      <p className="text-xs font-semibold uppercase tracking-wide text-slate-500 dark:text-slate-400">{label}</p>
      <p className={`mt-1 truncate text-sm text-slate-800 dark:text-slate-200 ${mono ? "font-mono" : "font-medium"}`}>
        {value}
      </p>
    </div>
  );
}
