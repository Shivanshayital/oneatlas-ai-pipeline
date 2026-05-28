import { v4 as uuidv4 } from "uuid";
import {
  PipelineJob,
  StageEvent,
} from "../types";
import { logger } from "../logging/logger";
import { MultiProviderGateway } from "../ai/gateway";
import { jobStore } from "../store/job-store";

// ============================================================================
// Pipeline Orchestrator
// ============================================================================

export class PipelineOrchestrator {

  private eventListeners: Array<(event: StageEvent) => void> = [];

  constructor(_gateway: MultiProviderGateway) {}

  onEvent(listener: (event: StageEvent) => void): void {
    this.eventListeners.push(listener);
  }

  /**
   * Initializes a job in the store and returns the ID.
   * Note: The actual execution of the pipeline happens via the SSE stream route
   * (src/app/api/generate/[jobId]/stream/route.ts) to prevent serverless timeouts
   * in the POST request and ensure the instance stays alive during processing.
   */
  async processPrompt(prompt: string): Promise<string> {
    const jobId = uuidv4();
    jobStore.createJob(jobId, prompt);
    return jobId;
  }

  getJob(jobId: string): PipelineJob | undefined {
    const state = jobStore.getJob(jobId);
    if (!state) {
      // Graceful detection: log the miss as it's a known side effect of serverless memory resets
      logger.warn(`[Orchestrator] Job ${jobId} not found in memory. This usually occurs after a Vercel serverless instance cold start.`);
      return undefined;
    }
    return state.job;
  }
}
