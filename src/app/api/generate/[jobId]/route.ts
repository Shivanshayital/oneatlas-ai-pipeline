import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/backend/store/job-store";
import { logger } from "@/backend/logging/logger";
import { availableProviders, loadConfig } from "@/backend/config";
import type { AIProvider } from "@/backend/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface Params {
  jobId: string;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  try {
    const { jobId } = await params;

    // Validate UUID format
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json({ error: "Invalid job ID format" }, { status: 400 });
    }

    const jobState = jobStore.getJob(jobId);

    if (!jobState) {
      return NextResponse.json({ error: "Job not found" }, { status: 404 });
    }

    const { job } = jobState;
    const repairs = jobStore.getRepairs(jobId);
    const events = jobStore.getEvents(jobId);
    const providerHistory = jobStore.getProviderHistory(jobId);
    const retryHistory = jobStore.getRetryHistory(jobId);
    const validationSnapshots = jobStore.getValidationSnapshots(jobId);
    const metrics = jobStore.getMetrics(jobId);
    const configuredProviders = availableProviders(loadConfig()) as AIProvider[];

    const response: Record<string, unknown> = {
      job_id: job.id,
      status: job.status,
      prompt: job.prompt,
      created_at: job.created_at,
      updated_at: job.updated_at,
      events,
      repairs,
      provider_history: providerHistory,
      retry_history: retryHistory,
      validation_snapshots: validationSnapshots,
      metrics,
      provider_usage_summary: jobStore.getProviderUsageSummary(jobId, configuredProviders),
    };

    if (job.result) {
      response.result = {
        intent: job.result.intent,
        schema: job.result.schema,
        spec: job.result.spec,
      };
    }

    if (job.error) {
      response.error = job.error;
    }

    return NextResponse.json(response);
  } catch (error) {
    logger.error("GET /api/generate/:jobId failed", error as Error); // Explicit cast
    return NextResponse.json(
      { error: "Failed to retrieve job" },
      { status: 500 }
    );
  }
}
