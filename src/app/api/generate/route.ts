import { NextRequest, NextResponse } from "next/server";
import { v4 as uuidv4 } from "uuid";
import { loadConfig, availableProviders, configurationWarnings, validateEnvironment } from "@/backend/config";
import { jobStore } from "@/backend/store/job-store";
import { logger } from "@/backend/logging/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

interface GenerateRequest {
  prompt: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    let bodyText: string | undefined;
    try { // Explicit type for bodyText
      bodyText = await request.text();
    } catch (err) {
      logger.error("Failed to read request body", err as Error);
      return NextResponse.json({ success: false, error: { message: "Failed to read request body", stage: "input", provider: null, details: String(err) } }, { status: 400 });
    }

    let parsedBody: unknown = undefined;
    try { // Explicit type for parsedBody
      parsedBody = bodyText ? JSON.parse(bodyText) : undefined;
    } catch (err) {
      logger.error("POST /api/generate failed - invalid JSON", err as Error, { rawBody: bodyText });
      return NextResponse.json(
        {
          success: false,
          error: {
            message: "Invalid JSON body",
            stage: "input",
            provider: null,
            details: String(err instanceof Error ? err.message : err),
          },
        },
        { status: 400 }
      );
    }

    const { prompt } = (parsedBody ?? {}) as GenerateRequest;

    // Validate input
    if (!prompt || typeof prompt !== "string") {
      return NextResponse.json(
        { error: "Prompt must be a non-empty string" },
        { status: 400 }
      );
    }

    const trimmedPrompt = prompt.trim();

    if (trimmedPrompt.length < 10) {
      return NextResponse.json(
        { error: "Prompt must be at least 10 characters" },
        { status: 400 }
      );
    }

    if (trimmedPrompt.length > 5000) {
      return NextResponse.json(
        { error: "Prompt must be less than 5000 characters" },
        { status: 400 }
      );
    }

    // Load and validate environment configuration (non-fatal warnings)
    const config = loadConfig();
    const env = validateEnvironment(config);
    const warnings = configurationWarnings(config);
    const providers = availableProviders(config);

    if (!env.ok) {
      logger.error("No AI providers configured", undefined, { warnings });
      return NextResponse.json(
        { error: "Server configuration incomplete", details: warnings },
        { status: 500 }
      );
    }

    // Create job
    const jobId = uuidv4();
    await jobStore.createJob(jobId, trimmedPrompt);

    logger.info("Generation job created", { jobId, promptLength: trimmedPrompt.length });

    // The SSE route starts execution so Vercel keeps the function alive while streaming.
    return NextResponse.json(
      {
        job_id: jobId,
        status: "pending",
        created_at: new Date().toISOString(),
        available_providers: providers,
        configuration_warnings: warnings,
      },
      { status: 202, headers: { Location: `/api/generate/${jobId}` } }
    );
  } catch (error) {
    logger.error("POST /api/generate failed", error as Error);
    return NextResponse.json(
      { error: "Failed to start generation job" },
      { status: 500 }
    );
  }
}

export async function OPTIONS(): Promise<NextResponse> {
  return new NextResponse(null, {
    status: 200,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}
