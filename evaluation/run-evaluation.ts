import fs from "fs/promises";
import path from "path";
import { v4 as uuidv4 } from "uuid";
import { loadConfig, validateConfig, initializePipeline } from "../src/backend/config";
import { jobStore } from "../src/backend/store/job-store";
import { PipelineExecutor } from "../src/backend/pipeline/executor";
import {
  AppIntent,
  ProviderUsage,
  RetryEntry,
  ValidationSnapshot,
  PipelineStage,
} from "../src/backend/types";

interface EvaluationResult {
  job_id: string;
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  failed_stage?: PipelineStage;
  repair_strategies: string[];
  retry_count: number;
  latency: {
    intent_stage_ms: number;
    schema_stage_ms: number;
    spec_stage_ms: number;
    total_ms: number;
  };
  estimated_cost_usd: number;
  integrations_detected: string[];
  clarification_required: boolean;
  provider_history: ProviderUsage[];
  retry_history: RetryEntry[];
  validation_snapshots: ValidationSnapshot[];
  created_at: string;
  updated_at: string;
}

const evaluationDir = path.resolve(__dirname);
const resultsPath = path.join(evaluationDir, "results.json");
const summaryPath = path.join(evaluationDir, "summary.md");

const prompts = [
  "Build a lightweight CRM for a service business with client tracking, task management, and Slack integration.",
  "Create an order management dashboard for a small retail team that uses Stripe and webhook automation.",
  "Design a booking and scheduling app with user profiles, calendar events, and email integration.",
];

async function runEvaluation() {
  const config = loadConfig();
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`Configuration invalid: ${configErrors.join("; ")}`);
  }

  const gateway = initializePipeline(config);
  const executor = new PipelineExecutor(gateway);
  const results: EvaluationResult[] = [];

  for (const prompt of prompts) {
    const jobId = uuidv4();
    jobStore.createJob(jobId, prompt);

    try {
      await executor.executePipeline(jobId, prompt);
    } catch (error) {
      // Pipeline errors are captured in job state already.
    }

    const state = jobStore.getJob(jobId);
    if (!state) continue;

    const failedEvent = state.events.find((event) => event.type === "stage_failed");
    const repairStrategies = Array.from(
      new Set(state.repairs.map((repair) => repair.strategy))
    );
    const retryCount = state.retry_history.length;
    const intentStage = state.stage_outputs.intent as AppIntent | undefined;
    const integrationsDetected = Array.isArray(intentStage?.integrations_requested)
      ? intentStage.integrations_requested
      : [];
    const clarificationRequired = Boolean(intentStage?.clarification_required);
    const metrics = state.metrics;

    results.push({
      job_id: state.job.id,
      prompt: state.job.prompt,
      status: state.job.status,
      failed_stage: failedEvent?.stage,
      repair_strategies: repairStrategies,
      retry_count: retryCount,
      latency: metrics.latency,
      estimated_cost_usd: metrics.tokens.estimated_cost,
      integrations_detected: integrationsDetected,
      clarification_required: clarificationRequired,
      provider_history: state.provider_history,
      retry_history: state.retry_history,
      validation_snapshots: state.validation_snapshots,
      created_at: state.job.created_at,
      updated_at: state.job.updated_at,
    });
  }

  await fs.mkdir(evaluationDir, { recursive: true });
  await fs.writeFile(resultsPath, JSON.stringify(results, null, 2), "utf-8");
  await generateSummary(results);
  console.log(`Evaluation complete. Results written to ${resultsPath}`);
}

async function generateSummary(results: EvaluationResult[]) {
  const total = results.length;
  const completed = results.filter((result) => result.status === "completed").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const successRate = total === 0 ? 0 : Math.round((completed / total) * 100);

  const failureCounts = results.reduce<Record<string, number>>((counts, result) => {
    const key = result.failed_stage ?? "none";
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});

  const strongestFailure = Object.entries(failureCounts)
    .filter(([stage]) => stage !== "none")
    .sort(([, a], [, b]) => b - a)[0];

  const averageLatency = total === 0
    ? 0
    : Math.round(
        results.reduce((sum, result) => sum + result.latency.total_ms, 0) / total
      );

  const averageCost = total === 0
    ? 0
    : Number(
        (
          results.reduce((sum, result) => sum + result.estimated_cost_usd, 0) / total
        ).toFixed(4)
      );

  const repairSuccessCount = results.reduce((sum, result) => {
    const successfulRepairs = result.validation_snapshots.filter((snapshot) => snapshot.valid).length;
    return sum + successfulRepairs;
  }, 0);

  const summaryLines = [
    "# Evaluation Summary",
    "",
    `- Total scenarios executed: ${total}`,
    `- Successful executions: ${completed}`,
    `- Failed executions: ${failed}`,
    `- Success rate: ${successRate}%`,
    "",
    `- Average total latency: ${averageLatency}ms`,
    `- Average estimated cost: $${averageCost}`,
    "",
    `- Most common failure: ${strongestFailure ? `${strongestFailure[0]} (${strongestFailure[1]})` : "none"}`,
    `- Repair success count: ${repairSuccessCount}`,
    "",
    "## Recommendations",
    "- Review the stage with the highest failure count and improve model prompts or retry behavior for that stage.",
    "- Add more targeted schema repair rules for relation consistency and endpoint-entity bindings.",
    "- Continue collecting token cost data to refine stage-specific budget estimates.",
    "",
    "## Raw Results",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
  ];

  await fs.writeFile(summaryPath, summaryLines.join("\n"), "utf-8");
}

runEvaluation().catch((error) => {
  console.error("Evaluation run failed:", error);
  process.exit(1);
});
