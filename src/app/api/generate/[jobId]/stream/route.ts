import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/backend/store/job-store";
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
  request: NextRequest,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  try {
    const { jobId } = await params;
    logger.info(`[SSE] Connection requested for job: ${jobId}`);
    
    const { searchParams } = new URL(request.url);
    const promptFallback = searchParams.get("prompt");

    // Validate UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    let jobState = jobStore.getJob(jobId);

    // Self-healing for Vercel statelessness
    if (!jobState && promptFallback) {
      logger.info(`[SSE] Rehydrating missing job state: ${jobId}`);
      jobStore.createJob(jobId, promptFallback);
      jobState = jobStore.getJob(jobId);
    }

    if (!jobState) {
      return NextResponse.json(
        { error: "Job not found. Rehydration failed - please provide a prompt parameter." },
        { status: 404 }
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
            logger.warn("SSE enqueue ignored after stream closed", {
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
          
          const config = loadConfig();
          const gateway = initializePipeline(config);
          const executor = new PipelineExecutor(gateway);

          executor.executePipeline(jobId, jobState.job.prompt).catch((error) => {
            logger.error("Pipeline execution error", error as Error, { jobId });
          });
        }
      },
      cancel(): void {
        cleanup?.(); // Call cleanup if it exists
        cleanup = undefined;
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
    logger.error("GET /api/generate/:jobId/stream failed", error as Error); // Explicit cast
    return NextResponse.json(
      { error: "Failed to stream job updates" },
      { status: 500 }
    );
  }
}

function formatSSEMessage(event: StageEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
