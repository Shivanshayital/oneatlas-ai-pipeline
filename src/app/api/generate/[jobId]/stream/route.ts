import { NextResponse } from "next/server";
import { jobStore } from "@/backend/store/job-store";
import { JobState } from "@/backend/store/job-store";
import { StageEvent } from "@/backend/types";
import { logger } from "@/backend/logging/logger";
import { initializePipeline, loadConfig } from "@/backend/config";
import { PipelineExecutor } from "@/backend/pipeline/executor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

interface Params {
  jobId: string;
}

export async function GET(
  request: Request,
  context: { params: Promise<Params> }
): Promise<Response> {
  try {
    const { jobId } = await context.params;
    logger.info("Stream connected", { jobId });
    
    const { searchParams } = new URL(request.url);
    const promptFallback = searchParams.get("prompt");

    // Validate UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const jobState = await waitForJobState(jobId, promptFallback);

    if (!jobState) {
      logger.warn("Stream waiting for job timed out", { jobId });
      return NextResponse.json(
        { status: "waiting", job_id: jobId },
        { status: 202 }
      );
    }

    // Create readable stream for SSE
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>): void { // Explicit return type
        const encoder = new TextEncoder();
        let isClosed: boolean = false; // Explicit type
        let didCleanup = false;
        let heartbeatInterval: ReturnType<typeof setInterval> | undefined;
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        let unsubscribe: (() => void) | undefined;

        const cleanupOnce = (): void => {
          if (didCleanup) return;
          didCleanup = true;

          if (closeTimer) {
            clearTimeout(closeTimer);
            closeTimer = undefined;
          }

          if (heartbeatInterval) {
            clearInterval(heartbeatInterval);
            heartbeatInterval = undefined;
          }

          unsubscribe?.();
          unsubscribe = undefined;
        };

        const safeClose = (): void => {
          if (isClosed) return;
          isClosed = true;
          cleanupOnce();

          try {
            controller.close();
            logger.info("Stream closed", { jobId });
          } catch (error) {
            logger.warn("SSE stream close ignored after controller closed", {
              jobId,
              error: String(error),
            });
          }
        };

        const safeEnqueue = (message: string): void => {
          if (isClosed) return;

          try {
            controller.enqueue(encoder.encode(message));
          } catch (error) {
            isClosed = true;
            cleanupOnce();
            logger.warn("Stream failed", {
              jobId,
              error: String(error),
            });
          }
        };

        cleanup = (): void => { // Explicit return type
          isClosed = true;
          cleanupOnce();
        };

        // Send existing events first
        const existingEvents = jobStore.getEvents(jobId);
        for (const event of existingEvents) {
          const message = formatSSEMessage(event);
          safeEnqueue(message);
        }

        // If already completed, send final event and close
        if (jobState.job.status === "completed" || jobState.job.status === "failed") {
          const terminalEvent = terminalEventForJob(jobState.job.status, jobState.job.error);
          if (terminalEvent) {
            safeEnqueue(formatSSEMessage(terminalEvent));
          }
          safeClose();
          return;
        }

        // Register for live events
        unsubscribe = jobStore.addEventListener(jobId, (event: StageEvent) => { // Explicit type for event
          const message = formatSSEMessage(event);
          safeEnqueue(message);

          // Close stream when complete
          if (event.type === "generation_complete" || event.type === "stage_failed") {
            if (!closeTimer) {
              closeTimer = setTimeout(safeClose, 100);
            }
          }
        });

        // Heartbeat to keep connection alive
        heartbeatInterval = setInterval(() => {
          safeEnqueue(": heartbeat\n\n");
        }, 30000);

        if (jobStore.startProcessing(jobId)) {
          logger.info(`[SSE] Starting pipeline execution for job: ${jobId}`);
          
          try {
            const config = loadConfig();
            const gateway = initializePipeline(config);
            const executor = new PipelineExecutor(gateway);

            executor.executePipeline(jobId, jobState.job.prompt).catch((error) => {
              const message = error instanceof Error ? error.message : String(error);
              logger.error("Stream failed", error instanceof Error ? error : new Error(message), { jobId });
              jobStore.setJobError(jobId, message);
              jobStore.addEvent(jobId, {
                type: "stage_failed",
                stage: "failed",
                timestamp: new Date().toISOString(),
                error: message,
              });
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logger.error("Stream failed", error instanceof Error ? error : new Error(message), { jobId });
            jobStore.setJobError(jobId, message);
            jobStore.addEvent(jobId, {
              type: "stage_failed",
              stage: "failed",
              timestamp: new Date().toISOString(),
              error: message,
            });
          }
        }
      },
      cancel(): void {
        cleanup?.(); // Call cleanup if it exists
        cleanup = undefined;
        logger.info("Stream closed", { jobId, reason: "client_cancel" });
      },
    });

    return new NextResponse(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (error) {
    logger.error("Stream failed", error as Error); // Explicit cast
    return NextResponse.json(
      { error: "Failed to stream job updates" },
      { status: 500 }
    );
  }
}

function formatSSEMessage(event: StageEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}

async function waitForJobState(
  jobId: string,
  promptFallback: string | null
): Promise<JobState | undefined> {
  const startedAt = Date.now();

  while (Date.now() - startedAt <= 3000) {
    const jobState = jobStore.getJob(jobId);
    if (jobState) {
      return jobState;
    }

    if (promptFallback && promptFallback.trim().length >= 10) {
      logger.info("Stream waiting for job; rehydrating from prompt fallback", { jobId });
      jobStore.createJob(jobId, promptFallback.trim());
      return jobStore.getJob(jobId);
    }

    logger.info("Stream waiting for job", { jobId });
    await sleep(150);
  }

  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function terminalEventForJob(
  status: "completed" | "failed",
  error?: string
): StageEvent | undefined {
  if (status === "completed") {
    return {
      type: "generation_complete",
      stage: "complete",
      timestamp: new Date().toISOString(),
    };
  }

  return {
    type: "stage_failed",
    stage: "failed",
    timestamp: new Date().toISOString(),
    error: error ?? "Job failed",
  };
}
