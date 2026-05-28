import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/backend/store/job-store";
import { repairEngine } from "@/backend/repair/engine";
import { validationEngine } from "@/backend/validation/engine";
import { logger } from "@/backend/logging/logger";
import type { DataSchema } from "@/backend/types";

interface Params {
  jobId: string;
}

interface RepairRequest {
  stage: "intent" | "schema" | "spec";
  strategy?: "structural_repair" | "field_repair" | "consistency_repair";
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<Params> }
): Promise<NextResponse> {
  try {
    const { jobId } = await params;
    const { searchParams } = new URL(request.url);
    const promptFallback = searchParams.get("prompt");

    // Validate UUID
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (!uuidRegex.test(jobId)) {
      return NextResponse.json({ error: "Invalid job ID" }, { status: 400 });
    }

    const body = await request.json() as unknown;
    const { stage, strategy } = body as RepairRequest;

    if (!stage || !["intent", "schema", "spec"].includes(stage)) {
      return NextResponse.json(
        { error: "Invalid stage. Must be: intent, schema, or spec" },
        { status: 400 }
      );
    }

    let jobState = jobStore.getJob(jobId);

    // Self-healing for Vercel statelessness
    if (!jobState && promptFallback) {
      logger.info("Rehydrating job for repair request", { jobId });
      jobStore.createJob(jobId, promptFallback);
      jobState = jobStore.getJob(jobId);
    }

    if (!jobState) {
      return NextResponse.json(
        { error: "Job not found. Rehydration failed - please provide a 'prompt' query parameter." },
        { status: 404 }
      );
    }

    // Get stage output
    const stageOutput: unknown = jobStore.getStageOutput(jobId, stage); // Explicit type
    if (!stageOutput) {
      return NextResponse.json(
        { error: `No output for stage: ${stage}` },
        { status: 400 }
      );
    }

    // Repair based on strategy
    let repairedData: Record<string, unknown> = stageOutput as Record<string, unknown>; // Explicit type
    const repairs: Array<{ strategy: string; action: string; outcome: string }> = [];

    if (!strategy || strategy === "structural_repair") {
      // Try structural repair if it's a string
      if (typeof stageOutput === "string") {
        const { content, logs } = repairEngine.repairStructure(stage, stageOutput);
        try {
          repairedData = JSON.parse(content);
          for (const log of logs) {
            jobStore.addRepair(jobId, log);
            repairs.push({
              strategy: log.strategy,
              action: log.action,
              outcome: log.outcome,
            });
          }
        } catch (parseError) {
          return NextResponse.json( // Explicit type for parseError
            { error: "Structural repair failed: Invalid JSON" },
            { status: 400 }
          );
        }
      }
    }

    if (!strategy || strategy === "field_repair") {
      const requiredFields = getRequiredFields(stage);
      const { data: fieldRepaired, logs: fieldLogs } = repairEngine.repairFields(
        stage,
        repairedData,
        requiredFields
      );
      repairedData = fieldRepaired;
      for (const log of fieldLogs) {
        jobStore.addRepair(jobId, log);
        repairs.push({
          strategy: log.strategy,
          action: log.action,
          outcome: log.outcome,
        });
      }
    }

    if (!strategy || strategy === "consistency_repair") {
      const schema = jobStore.getStageOutput(jobId, "schema") as DataSchema | null;
      const { data: consistencyRepaired, logs: consistencyLogs } =
        repairEngine.repairConsistency(stage, repairedData, schema);
      repairedData = consistencyRepaired;
      for (const log of consistencyLogs) {
        jobStore.addRepair(jobId, log);
        repairs.push({
          strategy: log.strategy,
          action: log.action,
          outcome: log.outcome,
        });
      }
    }

    // Validate repaired data
    const validationResult =
      stage === "intent"
        ? validationEngine.validateAppIntent(repairedData)
        : stage === "schema"
          ? validationEngine.validateDataSchema(repairedData)
          : validationEngine.validateAppSpec(repairedData);

    if (!validationResult.valid) {
      return NextResponse.json(
        {
          error: "Validation still failing after repair",
          validation_errors: validationResult.errors,
        },
        { status: 400 }
      );
    }

    // Update stage output
    jobStore.setStageOutput(jobId, stage, repairedData);

    logger.info("Manual repair completed", {
      jobId,
      stage,
      repairCount: repairs.length,
    });

    return NextResponse.json({
      success: true,
      stage,
      repairs,
      data: repairedData,
    });
  } catch (error) {
    logger.error("POST /api/generate/:jobId/repair failed", error as Error); // Explicit cast
    return NextResponse.json(
      { error: "Repair failed" },
      { status: 500 }
    );
  }
}

function getRequiredFields(stage: string): string[] {
  switch (stage) {
    case "intent":
      return [
        "appName",
        "appType",
        "features",
        "entities",
        "integrations_requested",
        "assumptions",
      ];
    case "schema":
      return ["schema_version", "entities"];
    case "spec":
      return [
        "metadata",
        "data_schema",
        "pages",
        "api_endpoints",
        "auth_rules",
      ];
    default:
      return [];
  }
}
