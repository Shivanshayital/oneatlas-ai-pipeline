import React from "react";
import type { AIProvider, ProviderUsageSummary, ProviderUsage } from "@/backend/types";

interface ProviderUsageDashboardProps {
  providerUsageSummary: ProviderUsageSummary | null;
  providerHistory: ProviderUsage[]; // For live updates or detailed history
}

const ProviderUsageDashboard: React.FC<ProviderUsageDashboardProps> = ({
  providerUsageSummary,
  providerHistory,
}) => {
  // Aggregate current session usage from providerHistory for providers not in summary yet
  const currentSessionUsage = new Map<AIProvider, { requests: number; promptTokens: number; completionTokens: number; totalTokens: number; estimatedCost: number; latencyMs: number; failures: number }>();

  providerHistory.forEach((usage) => {
    const current = currentSessionUsage.get(usage.provider) || {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      estimatedCost: 0,
      latencyMs: 0,
      failures: 0,
    };
    current.requests += 1;
    current.promptTokens += usage.tokens.input_tokens;
    current.completionTokens += usage.tokens.output_tokens;
    current.totalTokens += usage.tokens.total_tokens;
    current.estimatedCost += usage.cost_usd;
    current.latencyMs = (current.latencyMs * (current.requests - 1) + usage.latency_ms) / current.requests; // Simple average
    // Failures are tracked in jobStore.retry_history, not directly in providerUsage
    currentSessionUsage.set(usage.provider, current);
  });

  const allProviders: AIProvider[] = ["openrouter", "gemini", "deepseek", "groq", "openai"];

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <h2 className="text-base font-semibold text-slate-950 dark:text-slate-50">Provider Usage Dashboard</h2>
      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-2">
        {allProviders.map((providerId) => {
          const summary = providerUsageSummary?.[providerId];
          const sessionUsage = currentSessionUsage.get(providerId);

          const displayRequests = sessionUsage?.requests ?? summary?.requests ?? 0;
          const displayPromptTokens = sessionUsage?.promptTokens ?? summary?.promptTokens ?? 0;
          const displayCompletionTokens = sessionUsage?.completionTokens ?? summary?.completionTokens ?? 0;
          const displayTotalTokens = sessionUsage?.totalTokens ?? summary?.totalTokens ?? 0;
          const displayEstimatedCost = sessionUsage?.estimatedCost ?? summary?.estimatedCost ?? 0;
          const displayLatency = sessionUsage?.latencyMs ?? summary?.latencyMs ?? 0;
          const displayStatus = displayRequests > 0 ? "active" : summary?.status ?? "inactive";
          const displayModel =
            summary?.model ??
            [...providerHistory].reverse().find((usage) => usage.provider === providerId)?.model ??
            "N/A";
          const displayQuotaStatus = summary?.quotaStatus ?? "unknown";
          const displayRemainingQuota = summary?.estimatedRemainingQuota ?? 0;
          const displayHealthScore = summary?.healthScore;
          const displaySuccessRate = summary?.successRate;
          const displayFailures = sessionUsage?.failures ?? summary?.failures ?? 0;
          const cooldownMs = summary?.cooldownUntil
            ? Math.max(0, new Date(summary.cooldownUntil).getTime() - Date.now())
            : 0;

          const getQuotaBadgeColor = (status: typeof displayQuotaStatus): string => {
            switch (status) {
              case 'low': return 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200';
              case 'medium': return 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200';
              case 'high': return 'bg-orange-100 text-orange-800 dark:bg-orange-900 dark:text-orange-200';
              case 'near_limit': return 'bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200';
              default: return 'bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300';
            }
          };

          return (
            <div
              key={providerId}
              className="rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm shadow-sm dark:border-slate-800 dark:bg-slate-900/70"
            >
              <div className="flex items-center justify-between">
                <h3 className="font-semibold capitalize text-slate-950 dark:text-slate-50">
                  {providerId.replace('-', ' ')}
                </h3>
                <span
                  className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${
                    displayStatus === "active"
                      ? "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200"
                      : displayStatus === "healthy"
                      ? "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200"
                      : displayStatus === "cooldown"
                      ? "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200"
                      : displayStatus === "failed"
                      ? "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200"
                      : "bg-slate-100 text-slate-800 dark:bg-slate-700 dark:text-slate-300"
                  }`}
                >
                  {displayStatus}
                </span>
              </div>
              <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
                Model: <span className="font-mono">{displayModel}</span>
              </p>
              <div className="mt-3 space-y-1">
                <p>
                  Requests: <span className="font-medium">{displayRequests}</span>
                </p>
                <p>
                  Prompt Tokens: <span className="font-medium">{displayPromptTokens.toLocaleString()}</span>
                </p>
                <p>
                  Completion Tokens: <span className="font-medium">{displayCompletionTokens.toLocaleString()}</span>
                </p>
                <p>
                  Total Tokens: <span className="font-medium">{displayTotalTokens.toLocaleString()}</span>
                </p>
                <p>
                  Estimated Cost: <span className="font-medium">${displayEstimatedCost.toFixed(4)}</span>
                </p>
                <p>
                  Latency (avg): <span className="font-medium">{displayLatency.toFixed(1)}ms</span>
                </p>
                <p>
                  Health Score: <span className="font-medium">{displayHealthScore === undefined ? "N/A" : `${Math.round(displayHealthScore * 100)}%`}</span>
                </p>
                <p>
                  Success Rate: <span className="font-medium">{displaySuccessRate === undefined ? "N/A" : `${Math.round(displaySuccessRate * 100)}%`}</span>
                </p>
                <p>
                  Retries/Failures: <span className="font-medium">{displayFailures}</span>
                </p>
                {summary?.cooldownUntil && (
                  <p>
                    Cooldown: <span className="font-medium">{Math.ceil(cooldownMs / 1000)}s</span>
                  </p>
                )}
                {summary?.failureReason && (
                  <p className="break-words text-xs text-red-600 dark:text-red-300">
                    {summary.failureReason}
                  </p>
                )}
                {displayQuotaStatus !== 'unknown' && (
                  <div className="flex items-center gap-2">
                    <p>Quota Status:</p>
                    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${getQuotaBadgeColor(displayQuotaStatus)}`}>
                      {displayQuotaStatus.replace('_', ' ')}
                    </span>
                    {displayQuotaStatus !== 'low' && (
                      <p className="text-xs text-slate-500 dark:text-slate-400">
                        ({displayRemainingQuota.toLocaleString()} tokens remaining)
                      </p>
                    )}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
};

export default ProviderUsageDashboard;
