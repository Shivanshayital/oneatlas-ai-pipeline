import { v4 as uuidv4 } from "uuid";
import {
  PipelineJob,
  StageEvent,
} from "../types";
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
    return jobStore.getJob(jobId)?.job;
  }
}
