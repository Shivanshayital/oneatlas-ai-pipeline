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
import { getModelHealthScore, getModelHealthSnapshot, providerHealth } from "../ai/gateway";

const JOB_TTL_SECONDS = 60 * 60;
const REDIS_RETRY_ATTEMPTS = 3;
const REDIS_RETRY_DELAY_MS = 120;

export interface JobState {
  job: PipelineJob;
  events: StageEvent[];
  repairs: RepairLog[];
  stage_outputs: Record<string, unknown>;
  provider_history: ProviderUsage[];
  retry_history: RetryEntry[];
  validation_snapshots: ValidationSnapshot[];
  metrics: PipelineMetrics;
}

type JobStatus = PipelineJob["status"];
type Listener = (event: StageEvent) => void;
type RedisPrimitive = string | number;
type RedisCommand = [string, ...RedisPrimitive[]];

interface RedisEnvelope<T> {
  result?: T;
  error?: string;
}

interface RedisConfig {
  url: string;
  token: string;
}

export class JobStore {
  private memoryJobs: Map<string, JobState>;
  private listeners: Map<string, Set<Listener>>;
  private redisConfig: RedisConfig | null;

  constructor() {
    this.memoryJobs = new Map();
    this.listeners = new Map();
    this.redisConfig = resolveRedisConfig();
  }

  async createJob(id: string, prompt: string): Promise<PipelineJob> {
    const now = new Date().toISOString();
    const job: PipelineJob = {
      id,
      prompt,
      status: "pending",
      created_at: now,
      updated_at: now,
    };

    const state: JobState = {
      job,
      events: [],
      repairs: [],
      stage_outputs: {},
      provider_history: [],
      retry_history: [],
      validation_snapshots: [],
      metrics: emptyMetrics(),
    };

    await this.persistState(id, state);
    this.listeners.set(id, this.listeners.get(id) ?? new Set());

    logger.info("Job created", {
      jobId: id,
      persistent: Boolean(this.redisConfig),
      prompt_preview: prompt.substring(0, 50) + "...",
    });

    return job;
  }

  async getJob(id: string): Promise<JobState | undefined> {
    const state = await this.readState(id);
    if (!state) {
      logger.warn("Job not found", {
        jobId: id,
        persistent: Boolean(this.redisConfig),
      });
      return undefined;
    }

    logger.debug("Job retrieved", { jobId: id, status: state.job.status });
    return state;
  }

  async updateJob(
    id: string,
    updater: Partial<PipelineJob> | ((state: JobState) => void | Promise<void>)
  ): Promise<void> {
    await this.mutateState(id, async (state) => {
      if (typeof updater === "function") {
        await updater(state);
      } else {
        state.job = {
          ...state.job,
          ...updater,
          updated_at: new Date().toISOString(),
        };
      }
    });
    logger.info("Job updated", { jobId: id });
  }

  async updateJobStatus(id: string, status: JobStatus): Promise<void> {
    await this.updateJob(id, { status });
  }

  async startProcessing(id: string): Promise<boolean> {
    let started = false;

    await this.mutateState(id, (state) => {
      if (state.job.status !== "pending") {
        return;
      }

      state.job.status = "processing";
      state.job.updated_at = new Date().toISOString();
      started = true;
    });

    if (started) {
      logger.info("Job updated", { jobId: id, status: "processing" });
    }

    return started;
  }

  async setJobResult(id: string, result: JobResult): Promise<void> {
    await this.finalizeJob(id, "completed", result);
  }

  async setPartialJobResult(id: string, result: JobResult): Promise<void> {
    await this.updateJob(id, (state) => {
      state.job.result = result;
      state.job.updated_at = new Date().toISOString();
    });
  }

  async setJobError(id: string, error: string): Promise<void> {
    await this.finalizeJob(id, "failed", undefined, error);
  }

  async finalizeJob(
    id: string,
    status: "completed" | "failed",
    result?: JobResult,
    error?: string
  ): Promise<void> {
    await this.mutateState(id, (state) => {
      state.job.status = status;
      state.job.updated_at = new Date().toISOString();
      if (result) {
        state.job.result = result;
      }
      if (error) {
        state.job.error = error;
      }
    });

    logger.info("Job finalized", { jobId: id, status });
  }

  async appendStage(id: string, event: StageEvent): Promise<void> {
    await this.addEvent(id, event);
  }

  async addEvent(id: string, event: StageEvent): Promise<void> {
    await this.mutateState(id, (state) => {
      state.events.push(event);
    });
    this.notifyListeners(id, event);
  }

  async appendRepair(id: string, repair: RepairLog): Promise<void> {
    await this.addRepair(id, repair);
  }

  async addRepair(id: string, repair: RepairLog): Promise<void> {
    await this.mutateState(id, (state) => {
      state.repairs.push(repair);
    });
  }

  async setStageOutput(id: string, stage: string, output: unknown): Promise<void> {
    await this.mutateState(id, (state) => {
      state.stage_outputs[stage] = output;
    });
  }

  async getStageOutput(id: string, stage: string): Promise<unknown> {
    const state = await this.getJob(id);
    return state?.stage_outputs[stage];
  }

  async setMetrics(id: string, metrics: PipelineMetrics): Promise<void> {
    await this.mutateState(id, (state) => {
      state.metrics = metrics;
    });
  }

  async getMetrics(id: string): Promise<PipelineMetrics | undefined> {
    return (await this.getJob(id))?.metrics;
  }

  async addProviderUsage(id: string, usage: ProviderUsage): Promise<void> {
    await this.mutateState(id, (state) => {
      state.provider_history.push(usage);
    });
  }

  async addRetryHistory(id: string, retry: RetryEntry): Promise<void> {
    await this.mutateState(id, (state) => {
      state.retry_history.push(retry);
    });
  }

  async addValidationSnapshot(id: string, snapshot: ValidationSnapshot): Promise<void> {
    await this.mutateState(id, (state) => {
      state.validation_snapshots.push(snapshot);
    });
  }

  async getProviderHistory(id: string): Promise<ProviderUsage[]> {
    return (await this.getJob(id))?.provider_history ?? [];
  }

  async getProviderUsageSummary(
    id: string,
    configuredProviders: AIProvider[] = []
  ): Promise<ProviderUsageSummary> {
    const history = await this.getProviderHistory(id);
    const retries = await this.getRetryHistory(id);
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
      const model = providerHistory.at(-1)?.model;
      const providerModels = getModelHealthSnapshot().filter((health) => health.provider === provider);
      const activeHealth = model
        ? providerModels.find((health) => health.model === model)
        : providerModels.sort((a, b) => getModelHealthScore(provider, b.model) - getModelHealthScore(provider, a.model))[0];
      const cooldownUntil = providerHealth.getCooldownUntil(provider) ?? activeHealth?.cooldownUntil;
      const healthScore = activeHealth ? getModelHealthScore(provider, activeHealth.model) : undefined;
      const attempts = (activeHealth?.successCount ?? 0) + (activeHealth?.failureCount ?? 0);

      summary[provider] = {
        provider,
        model: model ?? activeHealth?.model,
        requests,
        promptTokens: inputTokens,
        completionTokens: outputTokens,
        totalTokens,
        estimatedCost,
        latencyMs: requests > 0 ? latencyTotal / requests : 0,
        status:
          cooldownUntil
            ? "cooldown"
            : activeHealth?.status === "failed"
              ? "failed"
              : requests > 0
                ? "active"
                : failures > 0
                  ? "failed"
                  : configuredProviders.includes(provider)
                    ? "healthy"
                    : "inactive",
        cooldownUntil: cooldownUntil ? new Date(cooldownUntil).toISOString() : undefined,
        failureReason: providerHealth.getReason(provider),
        healthScore,
        successRate: attempts > 0 ? (activeHealth?.successCount ?? 0) / attempts : undefined,
        estimatedRemainingQuota,
        quotaStatus: quota ? quotaStatus(totalTokens, quota) : "unknown",
        failures,
      };

      return summary;
    }, {} as ProviderUsageSummary);
  }

  async getRetryHistory(id: string): Promise<RetryEntry[]> {
    return (await this.getJob(id))?.retry_history ?? [];
  }

  async getValidationSnapshots(id: string): Promise<ValidationSnapshot[]> {
    return (await this.getJob(id))?.validation_snapshots ?? [];
  }

  addEventListener(id: string, listener: Listener): () => void {
    const listeners = this.listeners.get(id) || new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(id, listeners);

    return () => {
      listeners.delete(listener);
    };
  }

  async getEvents(id: string): Promise<StageEvent[]> {
    return (await this.getJob(id))?.events ?? [];
  }

  async getRepairs(id: string): Promise<RepairLog[]> {
    return (await this.getJob(id))?.repairs ?? [];
  }

  async cleanup(): Promise<void> {
    if (this.redisConfig) {
      return;
    }

    const now = Date.now();
    for (const [id, state] of this.memoryJobs.entries()) {
      const updatedAt = new Date(state.job.updated_at).getTime();
      if (now - updatedAt > JOB_TTL_SECONDS * 1000) {
        this.memoryJobs.delete(id);
        this.listeners.delete(id);
      }
    }
  }

  private async mutateState(
    id: string,
    mutator: (state: JobState) => void | Promise<void>
  ): Promise<JobState | undefined> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= REDIS_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const state = await this.readState(id);
        if (!state) {
          return undefined;
        }

        await mutator(state);
        await this.persistState(id, state);
        return state;
      } catch (error) {
        lastError = error;
        logger.warn("Job update retry", {
          jobId: id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(REDIS_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async readState(id: string): Promise<JobState | undefined> {
    if (!this.redisConfig) {
      return this.memoryJobs.get(id);
    }

    const raw = await this.redisCommand<string | null>(["GET", this.key(id)]);
    logger.debug("Redis read", {
      jobId: id,
      hit: Boolean(raw),
      key: this.key(id),
    });
    if (!raw) {
      return undefined;
    }

    return JSON.parse(raw) as JobState;
  }

  private async persistState(id: string, state: JobState): Promise<void> {
    if (!this.redisConfig) {
      this.memoryJobs.set(id, state);
      return;
    }

    await this.redisCommand<string>([
      "SET",
      this.key(id),
      JSON.stringify(state),
      "EX",
      JOB_TTL_SECONDS,
    ]);
    logger.debug("Redis write", {
      jobId: id,
      key: this.key(id),
      ttlSeconds: JOB_TTL_SECONDS,
      status: state.job.status,
      eventCount: state.events.length,
      repairCount: state.repairs.length,
    });
  }

  private async redisCommand<T>(command: RedisCommand): Promise<T> {
    if (!this.redisConfig) {
      throw new Error("Redis is not configured");
    }

    let lastError: unknown;

    for (let attempt = 1; attempt <= REDIS_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(this.redisConfig.url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${this.redisConfig.token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(command),
          cache: "no-store",
        });

        if (!response.ok) {
          throw new Error(`Redis command failed: ${response.status} ${response.statusText}`);
        }

        const payload = (await response.json()) as RedisEnvelope<T>;
        if (payload.error) {
          throw new Error(payload.error);
        }

        return payload.result as T;
      } catch (error) {
        lastError = error;
        logger.warn("Redis command retry", {
          command: command[0],
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(REDIS_RETRY_DELAY_MS * attempt);
      }
    }

    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private notifyListeners(id: string, event: StageEvent): void {
    const listeners = this.listeners.get(id);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        logger.warn("Job listener failed", {
          jobId: id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private key(id: string): string {
    return `oneatlas:job:${id}`;
  }
}

const globalRef = globalThis as unknown as {
  __jobStore?: JobStore;
};
if (!globalRef.__jobStore) {
  globalRef.__jobStore = new JobStore();
}

export const jobStore: JobStore = globalRef.__jobStore;

function resolveRedisConfig(): RedisConfig | null {
  const url = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    logger.warn("Persistent job store not configured; falling back to in-memory storage");
    return null;
  }

  return { url, token };
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

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
