// ============================================================================
// Example Implementation: POST /api/generate
// File: src/app/api/generate/route.ts
// ============================================================================

/*
Copy this file to src/app/api/generate/route.ts

This demonstrates the complete implementation of the job submission endpoint
using all the backend modules we created.
*/

import { NextRequest, NextResponse } from "next/server";
import { validateConfig, initializePipeline, loadConfig } from "@/backend/config";
import { logger } from "@/backend/logging/logger";

interface GenerateRequest {
  prompt: string;
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json() as unknown;
    const { prompt } = body as GenerateRequest;

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
        { error: "Prompt must be at least 10 characters long" },
        { status: 400 }
      );
    }

    if (trimmedPrompt.length > 5000) {
      return NextResponse.json(
        { error: "Prompt must be less than 5000 characters" },
        { status: 400 }
      );
    }

    // Load and validate configuration
    const config = loadConfig();
    const configErrors = validateConfig(config);

    if (configErrors.length > 0) {
      logger.error("Configuration validation failed", undefined, {
        errors: configErrors,
      });
      return NextResponse.json(
        {
          error: "Server configuration incomplete",
          details: configErrors,
        },
        { status: 500 }
      );
    }

    // Initialize pipeline and start job
    const orchestrator = initializePipeline(config);
    const jobId = await orchestrator.processPrompt(trimmedPrompt);

    logger.info("Generation job started", {
      jobId,
      promptLength: trimmedPrompt.length,
    });

    // Return job ID with 202 Accepted status
    return NextResponse.json(
      {
        job_id: jobId,
        status: "pending",
        created_at: new Date().toISOString(),
      },
      { status: 202, headers: { Location: `/api/generate/${jobId}` } }
    );
  } catch (error) {
    logger.error("POST /api/generate failed", error as Error);

    return NextResponse.json(
      {
        error: "Failed to start generation job",
        message: process.env.NODE_ENV === "development" ? String(error) : undefined,
      },
      { status: 500 }
    );
  }
}

// Allow preflight requests
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
