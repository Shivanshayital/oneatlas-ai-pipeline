// ============================================================================
// Example Implementation: GET /api/generate/:jobId/stream (SSE)
// File: src/app/api/generate/[jobId]/stream/route.ts
// ============================================================================

/*
Copy this file to src/app/api/generate/[jobId]/stream/route.ts

This demonstrates Server-Sent Events (SSE) streaming for real-time pipeline
progress updates. The client connects and receives events as stages complete.

Example client-side usage:

  const eventSource = new EventSource(`/api/generate/${jobId}/stream`);
  
  eventSource.addEventListener('stage_start', (event) => {
    console.log('Stage started:', JSON.parse(event.data));
  });
  
  eventSource.addEventListener('stage_complete', (event) => {
    console.log('Stage complete:', JSON.parse(event.data));
  });
  
  eventSource.addEventListener('generation_complete', (event) => {
    console.log('Done!', JSON.parse(event.data));
    eventSource.close();
  });
*/

import { NextRequest, NextResponse } from "next/server";
import { loadConfig, initializePipeline } from "@/backend/config";
import { logger } from "@/backend/logging/logger";
import { StageEvent } from "@/backend/types";

function createSSEResponse(
  onEvent: (listener: (event: StageEvent) => void) => void
): ReadableStream<Uint8Array> {
  return new ReadableStream((controller) => {
    const encoder = new TextEncoder();

    const sendEvent = (event: StageEvent) => {
      const eventMessage = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
      controller.enqueue(encoder.encode(eventMessage));
    };

    // Register listener
    onEvent(sendEvent);

    // Send initial heartbeat
    const heartbeat = setInterval(() => {
      controller.enqueue(encoder.encode(": heartbeat\n\n"));
    }, 30000);

    // Cleanup on close
    const cleanup = () => {
      clearInterval(heartbeat);
      controller.close();
    };

    (controller as any).cleanup = cleanup;
  });
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
): Promise<NextResponse> {
  try {
    const { jobId } = await params;

    // Validate jobId format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json(
        { error: "Invalid job ID format" },
        { status: 400 }
      );
    }

    const config = loadConfig();
    const orchestrator = initializePipeline(config);

    // Check if job exists
    const job = orchestrator.getJob(jobId);
    if (!job) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    // For already completed jobs, send cached events
    if (job.status === "completed" || job.status === "failed") {
      // In production, you'd retrieve cached events from a database
      // For now, just acknowledge the final state
      const finalEvent: StageEvent = {
        type:
          job.status === "completed"
            ? "generation_complete"
            : "stage_failed",
        stage: job.status === "completed" ? "complete" : "failed",
        timestamp: job.updated_at,
        error: job.error,
      };

      const stream = new ReadableStream<Uint8Array>((controller) => {
        const encoder = new TextEncoder();
        const eventMessage = `event: ${finalEvent.type}\ndata: ${JSON.stringify(finalEvent)}\n\n`;
        controller.enqueue(encoder.encode(eventMessage));
        controller.close();
      });

      return new NextResponse(stream, {
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no",
        },
      });
    }

    // For processing jobs, stream events
    const stream = createSSEResponse((registerListener) => {
      orchestrator.onEvent(registerListener);
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
