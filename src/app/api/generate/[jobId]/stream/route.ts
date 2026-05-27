import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/backend/store/job-store";
import { StageEvent } from "@/backend/types";
import { logger } from "@/backend/logging/logger";

interface Params {
  jobId: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  try {
    const { jobId } = await params;

    // Validate UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const jobState = jobStore.getJob(jobId);
    if (!jobState) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // Create readable stream for SSE
    let cleanup: (() => void) | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start(controller: ReadableStreamDefaultController<Uint8Array>) {
        const encoder = new TextEncoder();

        // Send existing events first
        const existingEvents = jobStore.getEvents(jobId);
        for (const event of existingEvents) {
          const message = formatSSEMessage(event);
          controller.enqueue(encoder.encode(message));
        }

        // If already completed, send final event and close
        if (jobState.job.status === "completed" || jobState.job.status === "failed") {
          controller.close();
          return;
        }

        // Register for live events
        const unsubscribe = jobStore.addEventListener(jobId, (event) => {
          const message = formatSSEMessage(event);
          controller.enqueue(encoder.encode(message));

          // Close stream when complete
          if (event.type === "generation_complete" || event.type === "stage_failed") {
            setTimeout(() => controller.close(), 100);
          }
        });

        // Heartbeat to keep connection alive
        const heartbeatInterval = setInterval(() => {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        }, 30000);

        cleanup = () => {
          clearInterval(heartbeatInterval);
          unsubscribe();
        };
      },
      cancel() {
        cleanup?.();
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
    logger.error("GET /api/generate/:jobId/stream failed", error as Error);
    return NextResponse.json(
      { error: "Failed to stream job updates" },
      { status: 500 }
    );
  }
}

function formatSSEMessage(event: StageEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
}
