import {
  PipelineJob,
  StageEvent,
  JobResult,
  RepairLog,
  PipelineMetrics,
  ProviderUsage,
  RetryEntry,
  ValidationSnapshot,
} from "../types";

// ============================================================================
// Job Store - In-Memory State Management
// ============================================================================

export interface JobState {
  job: PipelineJob;
  events: StageEvent[];
  repairs: RepairLog[];
  stage_outputs: {
    intent?: unknown;
    schema?: unknown;
    spec?: unknown;
  };
  provider_history: ProviderUsage[];
  retry_history: RetryEntry[];
  validation_snapshots: ValidationSnapshot[];
  metrics: PipelineMetrics;
}

export class JobStore {
  private jobs: Map<string, JobState> = new Map();
  private listeners: Map<string, Set<(event: StageEvent) => void>> = new Map();

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

    return job;
  }

  getJob(id: string): JobState | undefined {
    return this.jobs.get(id);
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
      (state.stage_outputs as Record<string, unknown>)[stage] = output;
    }
  }

  getStageOutput(id: string, stage: string): unknown {
    const state = this.jobs.get(id);
    if (state) {
      return (state.stage_outputs as Record<string, unknown>)[stage];
    }
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
          listener(event);
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
const globalRef = globalThis as unknown as Record<string, unknown>;
if (!globalRef.__ONEATLAS_JOB_STORE) {
  (globalRef as any).__ONEATLAS_JOB_STORE = new JobStore();
}

export const jobStore: JobStore = (globalRef as any).__ONEATLAS_JOB_STORE as JobStore;
