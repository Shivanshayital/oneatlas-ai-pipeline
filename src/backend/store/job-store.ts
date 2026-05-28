import {
  PipelineJob,
  StageEvent,
  JobResult,
  RepairLog,
  PipelineMetrics,
  ProviderUsage,
  ProviderUsageSummary,
  ProviderUsageSummaryItem,
  RetryEntry,
  ValidationSnapshot,
  AIProvider,
} from "../types";
import { logger } from "../logging/logger";

// ============================================================================
// Job Store - In-Memory State Management
// ============================================================================

export interface JobState {
  job: PipelineJob;
  events: StageEvent[];
  repairs: RepairLog[];
  stage_outputs: Record<string, unknown>; // Changed to Record<string, unknown> for dynamic access
  provider_history: ProviderUsage[];
  retry_history: RetryEntry[];
  validation_snapshots: ValidationSnapshot[];
  metrics: PipelineMetrics;
}

export class JobStore {
  private jobs: Map<string, JobState>;
  private listeners: Map<string, Set<(event: StageEvent) => void>>;

  constructor() {
    this.jobs = new Map();
    this.listeners = new Map();
  }

  createJob(id: string, prompt: string): PipelineJob {
    const job: PipelineJob = {
      id,
      prompt,
      status: "pending",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.jobs.set(id, {
      job,
      events: [],
      repairs: [],
      stage_outputs: {},
      provider_history: [],
      retry_history: [],
      validation_snapshots: [],
      metrics: {
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
      },
    });

    this.listeners.set(id, new Set());

    logger.info(`[JobStore] Initialized job: ${id}`, {
      activeJobs: this.jobs.size,
      prompt_preview: prompt.substring(0, 50) + "..."
    });

    return job;
  }

  getJob(id: string): JobState | undefined {
    const state = this.jobs.get(id);
    if (!state) {
      logger.warn(`[JobStore] Job NOT FOUND: ${id}`, {
        availableIds: Array.from(this.jobs.keys()),
        instanceCount: this.jobs.size
      });
    } else {
      logger.debug(`[JobStore] Job retrieved: ${id}`);
    }
    return state;
  }

  updateJobStatus(
    id: string,
    status: "pending" | "processing" | "completed" | "failed"
  ): void {
    const state = this.jobs.get(id);
    if (state) {
      state.job.status = status;
      state.job.updated_at = new Date().toISOString();
    }
  }

  startProcessing(id: string): boolean {
    const state = this.jobs.get(id);
    if (!state || state.job.status !== "pending") {
      return false;
    }

    state.job.status = "processing";
    state.job.updated_at = new Date().toISOString();
    return true;
  }

  setJobResult(id: string, result: JobResult): void {
    const state = this.jobs.get(id);
    if (state) {
      state.job.result = result;
      state.job.status = "completed";
      state.job.updated_at = new Date().toISOString();
    }
  }

  setJobError(id: string, error: string): void {
    const state = this.jobs.get(id);
    if (state) {
      state.job.error = error;
      state.job.status = "failed";
      state.job.updated_at = new Date().toISOString();
    }
  }

  addEvent(id: string, event: StageEvent): void {
    const state = this.jobs.get(id);
    if (state) {
      state.events.push(event);
      this._notifyListeners(id, event);
    }
  }

  addRepair(id: string, repair: RepairLog): void {
    const state = this.jobs.get(id);
    if (state) {
      state.repairs.push(repair);
    }
  }

  setStageOutput(id: string, stage: string, output: unknown): void {
    const state = this.jobs.get(id);
    if (state) {
      state.stage_outputs[stage] = output; // Access directly, stage_outputs is typed
    }
  }

  getStageOutput(id: string, stage: string): unknown {
    const state = this.jobs.get(id);
    if (state) {
      return (state.stage_outputs as Record<string, unknown>)[stage];
    } // Access directly, stage_outputs is typed
    return undefined;
  }

  setMetrics(id: string, metrics: PipelineMetrics): void {
    const state = this.jobs.get(id);
    if (state) {
      state.metrics = metrics;
    }
  }

  getMetrics(id: string): PipelineMetrics | undefined {
    return this.jobs.get(id)?.metrics;
  }

  addProviderUsage(id: string, usage: ProviderUsage): void {
    const state = this.jobs.get(id);
    if (state) {
      state.provider_history.push(usage);
    }
  }

  addRetryHistory(id: string, retry: RetryEntry): void {
    const state = this.jobs.get(id);
    if (state) {
      state.retry_history.push(retry);
    }
  }

  addValidationSnapshot(id: string, snapshot: ValidationSnapshot): void {
    const state = this.jobs.get(id);
    if (state) {
      state.validation_snapshots.push(snapshot);
    }
  }

  getProviderHistory(id: string): ProviderUsage[] {
    return this.jobs.get(id)?.provider_history ?? [];
  }

  getProviderUsageSummary(
    id: string,
    configuredProviders: AIProvider[] = []
  ): ProviderUsageSummary {
    const history = this.getProviderHistory(id);
    const retries = this.getRetryHistory(id);
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
      const providerHistory = history.filter((usage) => usage.provider === provider);
      const failures = retries.filter((retry) => retry.provider === provider).length;
      const requests = providerHistory.length;
      const inputTokens = providerHistory.reduce(
        (total, usage) => total + usage.tokens.input_tokens,
        0
      );
      const outputTokens = providerHistory.reduce(
        (total, usage) => total + usage.tokens.output_tokens,
        0
      );
      const totalTokens = providerHistory.reduce(
        (total, usage) => total + usage.tokens.total_tokens,
        0
      );
      const estimatedCost = providerHistory.reduce(
        (total, usage) => total + usage.tokens.estimated_cost,
        0
      );
      const latencyTotal = providerHistory.reduce(
        (total, usage) => total + usage.latency_ms,
        0
      );
      const quota = quotaForProvider(provider);
      const estimatedRemainingQuota = quota
        ? Math.max(0, quota - totalTokens)
        : 0;

      summary[provider] = {
        provider,
        model: providerHistory.at(-1)?.model,
        requests,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        estimatedCost,
        latencyMs: requests > 0 ? latencyTotal / requests : 0,
        status:
          requests > 0
            ? "active"
            : failures > 0
              ? "unhealthy"
              : configuredProviders.includes(provider)
                ? "healthy"
                : "inactive",
        estimatedRemainingQuota,
        quotaStatus: quota ? quotaStatus(totalTokens, quota) : "unknown",
        failures,
      };

      return summary;
    }, {} as ProviderUsageSummary);
  }

  getRetryHistory(id: string): RetryEntry[] {
    return this.jobs.get(id)?.retry_history ?? [];
  }

  getValidationSnapshots(id: string): ValidationSnapshot[] {
    return this.jobs.get(id)?.validation_snapshots ?? [];
  }

  addEventListener(
    id: string,
    listener: (event: StageEvent) => void
  ): () => void {
    const listeners = this.listeners.get(id) || new Set();
    listeners.add(listener);
    this.listeners.set(id, listeners);

    // Return unsubscribe function
    return () => {
      listeners.delete(listener);
    };
  }

  getEvents(id: string): StageEvent[] {
    const state = this.jobs.get(id);
    return state?.events ?? [];
  }

  getRepairs(id: string): RepairLog[] {
    const state = this.jobs.get(id);
    return state?.repairs ?? [];
  }

  private _notifyListeners(id: string, event: StageEvent): void {
    const listeners = this.listeners.get(id);
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(event); // Explicit type for event
        } catch (error) {
          console.error("Error in event listener:", error);
        }
      }
    }
  }

  // Cleanup old jobs (optional, for production)
  cleanup(maxAgeMs: number = 24 * 60 * 60 * 1000): void {
    const now = Date.now();
    for (const [id, state] of this.jobs.entries()) {
      const createdAt = new Date(state.job.created_at).getTime();
      if (now - createdAt > maxAgeMs) {
        this.jobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }
}

// Ensure a single JobStore instance across module reloads (Next.js dev hot reloads)
const globalRef = globalThis as unknown as {
  __jobStore?: JobStore;
};
if (!globalRef.__jobStore) {
  globalRef.__jobStore = new JobStore();
}

export const jobStore: JobStore = globalRef.__jobStore;

function quotaForProvider(provider: AIProvider): number | undefined {
  const quotas: Partial<Record<AIProvider, number>> = {
    gemini: 1_000_000,
    deepseek: 1_000_000,
    groq: 5_000_000,
    openai: 1_000_000,
  };
  return quotas[provider];
}

function quotaStatus(
  usedTokens: number,
  quota: number
): ProviderUsageSummaryItem["quotaStatus"] {
  const percentage = quota > 0 ? (usedTokens / quota) * 100 : 0;
  if (percentage >= 95) return "near_limit";
  if (percentage >= 80) return "high";
  if (percentage >= 50) return "medium";
  return "low";
}
