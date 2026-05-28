import { v4 as uuidv4 } from "uuid";
import {
  AppIntent,
  DataSchema,
  DataEntity,
  AppSpec,
  PipelineJob,
  StageEvent,
  JobResult,
  PipelineMetrics,
} from "../types";
import { MultiProviderGateway, MODEL_ROUTING } from "../ai/gateway";
import { jobStore } from "../store/job-store";

// ============================================================================
// System Prompts for Each Stage
// ============================================================================

const INTENT_EXTRACTION_PROMPT = `Extract the app intent from the user's description. Return valid JSON only (no markdown, no explanation).

Return ONLY a JSON object matching this structure:
{
  "appName": "string",
  "appType": "web|mobile|desktop|api|hybrid",
  "features": ["array", "of", "features"],
  "entities": ["array", "of", "entities"],
  "integrations_requested": ["array", "of", "integration", "ids"],
  "assumptions": ["array", "of", "assumptions"]
}

If the prompt is too vague, still proceed with reasonable assumptions. Do NOT ask for clarification.`;

const SCHEMA_GENERATION_PROMPT = `Generate a data schema based on the app intent. Return valid JSON only.

Every entity MUST have a "tenantId" field for multi-tenancy.

Return ONLY a JSON object matching this structure:
{
  "schema_version": "1.0.0",
  "entities": [
    {
      "name": "EntityName",
      "tableName": "entity_names",
      "fields": [
        {
          "name": "id",
          "type": "uuid",
          "required": true
        },
        {
          "name": "tenantId",
          "type": "uuid",
          "required": true
        }
      ],
      "relations": []
    }
  ]
}

Ensure all relations are bidirectionally consistent.`;

const SPEC_GENERATION_PROMPT = `Generate a complete app specification based on the intent and schema. Return valid JSON only.

Return ONLY a JSON object matching this structure:
{
  "metadata": {
    "app_name": "string",
    "app_type": "string",
    "version": "1.0.0",
    "created_at": "ISO timestamp"
  },
  "data_schema": {...},
  "pages": [{
    "name": "page_name",
    "path": "/path",
    "title": "Page Title",
    "requires_auth": false,
    "components": ["component1", "component2"]
  }],
  "api_endpoints": [{
    "path": "/api/endpoint",
    "method": "GET|POST|PUT|DELETE|PATCH",
    "entity": "EntityName",
    "auth_required": false,
    "response_type": "json"
  }],
  "auth_rules": [],
  "integration_hooks": [],
  "workflows": [],
  "assumptions": []
}`;

// ============================================================================
// Pipeline Orchestrator
// ============================================================================

export class PipelineOrchestrator {
  private gateway: MultiProviderGateway;
  private eventListeners: Array<(event: StageEvent) => void> = [];

  constructor(gateway: MultiProviderGateway) {
    this.gateway = gateway;
  }

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
