import { v4 as uuidv4 } from "uuid";
import {
  AppIntent,
  DataSchema,
  AppSpec,
  PipelineJob,
  StageEvent,
  JobResult,
  PipelineMetrics,
} from "../types";
import { MultiProviderGateway, MODEL_ROUTING } from "../ai/gateway";
import { validationEngine } from "../validation/engine";
import { repairEngine } from "../repair/engine";
import {
  AppIntentSchema,
  DataSchemaSchema,
  AppSpecSchema,
} from "../schemas";

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
  private jobs: Map<string, PipelineJob> = new Map();
  private metrics: Map<string, PipelineMetrics> = new Map();
  private eventListeners: Array<(event: StageEvent) => void> = [];

  constructor(gateway: MultiProviderGateway) {
    this.gateway = gateway;
  }

  onEvent(listener: (event: StageEvent) => void): void {
    this.eventListeners.push(listener);
  }

  async processPrompt(prompt: string): Promise<string> {
    const jobId = uuidv4();
    const job: PipelineJob = {
      id: jobId,
      prompt,
      status: "processing",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    this.jobs.set(jobId, job);
    this.metrics.set(jobId, {
      tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0, estimated_cost: 0 },
      latency: { intent_stage_ms: 0, schema_stage_ms: 0, spec_stage_ms: 0, total_ms: 0 },
      repair_attempts: 0,
      successful_repairs: 0,
    });

    try {
      const result = await this._runPipeline(prompt, jobId);
      job.status = "completed";
      job.result = result;
      this._emitEvent({
        type: "generation_complete",
        stage: "complete",
        timestamp: new Date().toISOString(),
        data: { jobId },
      });
    } catch (error) {
      job.status = "failed";
      job.error = String(error);
      this._emitEvent({
        type: "stage_failed",
        stage: "failed",
        timestamp: new Date().toISOString(),
        error: String(error),
      });
    }

    job.updated_at = new Date().toISOString();
    return jobId;
  }

  getJob(jobId: string): PipelineJob | undefined {
    return this.jobs.get(jobId);
  }

  getMetrics(jobId: string): PipelineMetrics | undefined {
    return this.metrics.get(jobId);
  }

  private async _runPipeline(prompt: string, jobId: string): Promise<JobResult> {
    const repairLogs: any[] = [];
    const metrics = this.metrics.get(jobId)!;
    const totalStartTime = Date.now();

    // ============ Stage 1: Intent Extraction ============
    this._emitEvent({
      type: "stage_start",
      stage: "intent",
      timestamp: new Date().toISOString(),
    });

    const intentStartTime = Date.now();
    let intent = await this._extractIntent(prompt);
    metrics.latency.intent_stage_ms = Date.now() - intentStartTime;

    this._emitEvent({
      type: "stage_complete",
      stage: "intent",
      timestamp: new Date().toISOString(),
      data: { intent },
    });

    // ============ Stage 2: Schema Generation ============
    this._emitEvent({
      type: "stage_start",
      stage: "schema",
      timestamp: new Date().toISOString(),
    });

    const schemaStartTime = Date.now();
    let schema = await this._generateSchema(intent, prompt);
    metrics.latency.schema_stage_ms = Date.now() - schemaStartTime;

    this._emitEvent({
      type: "stage_complete",
      stage: "schema",
      timestamp: new Date().toISOString(),
      data: { schema },
    });

    // ============ Stage 3: AppSpec Generation ============
    this._emitEvent({
      type: "stage_start",
      stage: "spec",
      timestamp: new Date().toISOString(),
    });

    const specStartTime = Date.now();
    let spec = await this._generateSpec(intent, schema, prompt);
    metrics.latency.spec_stage_ms = Date.now() - specStartTime;

    this._emitEvent({
      type: "stage_complete",
      stage: "spec",
      timestamp: new Date().toISOString(),
      data: { spec },
    });

    metrics.latency.total_ms = Date.now() - totalStartTime;

    return {
      intent,
      schema,
      spec,
      repairs_applied: repairLogs,
    };
  }

  private async _extractIntent(prompt: string): Promise<AppIntent> {
    const routingConfig = MODEL_ROUTING.intent;
    const [provider, model] = routingConfig.primary.split("/");

    try {
      const response = await this.gateway.send({
        provider: provider as any,
        model,
        messages: [
          { role: "system", content: INTENT_EXTRACTION_PROMPT },
          { role: "user", content: prompt },
        ],
        temperature: 0.3,
        max_tokens: 1024,
      });

      // Repair structural issues
      const { content: repairedJson } = repairEngine.repairStructure(
        "intent",
        response.content
      );

      let intentData: any;
      try {
        intentData = JSON.parse(repairedJson);
      } catch (parseError) {
        throw new Error(`Failed to parse intent JSON: ${String(parseError)}`);
      }

      // Repair fields
      const requiredFields = [
        "appName",
        "appType",
        "features",
        "entities",
        "integrations_requested",
        "assumptions",
      ];
      const { data: repairedData } = repairEngine.repairFields(
        "intent",
        intentData,
        requiredFields
      );

      // Validate
      const validationResult = validationEngine.validateAppIntent(repairedData);
      if (!validationResult.valid) {
        throw new Error(`Intent validation failed: ${JSON.stringify(validationResult.errors)}`);
      }

      return AppIntentSchema.parse(repairedData) as AppIntent;
    } catch (error) {
      console.error("Intent extraction failed:", error);
      throw error;
    }
  }

  private async _generateSchema(intent: AppIntent, originalPrompt: string): Promise<DataSchema> {
    const routingConfig = MODEL_ROUTING.schema;
    const [provider, model] = routingConfig.primary.split("/");

    try {
      const intentSummary = `App: ${intent.appName} (${intent.appType})\nFeatures: ${intent.features.join(", ")}\nEntities: ${intent.entities.join(", ")}`;

      const response = await this.gateway.send({
        provider: provider as any,
        model,
        messages: [
          { role: "system", content: SCHEMA_GENERATION_PROMPT },
          {
            role: "user",
            content: `Original prompt: ${originalPrompt}\n\nExtracted intent:\n${intentSummary}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 2048,
      });

      // Repair
      const { content: repairedJson } = repairEngine.repairStructure("schema", response.content);
      let schemaData: any;
      try {
        schemaData = JSON.parse(repairedJson);
      } catch (parseError) {
        throw new Error(`Failed to parse schema JSON: ${String(parseError)}`);
      }

      // Ensure every entity has tenantId
      if (schemaData.entities && Array.isArray(schemaData.entities)) {
        for (const entity of schemaData.entities) {
          if (!entity.fields) entity.fields = [];
          if (!entity.fields.find((f: any) => f.name === "tenantId")) {
            entity.fields.unshift({
              name: "tenantId",
              type: "uuid",
              required: true,
            });
          }
        }
      }

      const validationResult = validationEngine.validateDataSchema(schemaData);
      if (!validationResult.valid) {
        throw new Error(`Schema validation failed: ${JSON.stringify(validationResult.errors)}`);
      }

      return DataSchemaSchema.parse(schemaData) as DataSchema;
    } catch (error) {
      console.error("Schema generation failed:", error);
      throw error;
    }
  }

  private async _generateSpec(
    intent: AppIntent,
    schema: DataSchema,
    originalPrompt: string
  ): Promise<AppSpec> {
    const routingConfig = MODEL_ROUTING.spec;
    const [provider, model] = routingConfig.primary.split("/");

    try {
      const schemaJson = JSON.stringify(schema, null, 2);

      const response = await this.gateway.send({
        provider: provider as any,
        model,
        messages: [
          { role: "system", content: SPEC_GENERATION_PROMPT },
          {
            role: "user",
            content: `Original prompt: ${originalPrompt}\n\nData schema:\n${schemaJson}`,
          },
        ],
        temperature: 0.4,
        max_tokens: 4096,
      });

      // Repair
      const { content: repairedJson } = repairEngine.repairStructure("spec", response.content);
      let specData: any;
      try {
        specData = JSON.parse(repairedJson);
      } catch (parseError) {
        throw new Error(`Failed to parse spec JSON: ${String(parseError)}`);
      }

      // Ensure metadata
      if (!specData.metadata) {
        specData.metadata = {
          app_name: intent.appName,
          app_type: intent.appType,
          version: "1.0.0",
          created_at: new Date().toISOString(),
        };
      }

      // Ensure data schema is included
      specData.data_schema = schema;

      // Repair consistency
      const { data: repairedSpec } = repairEngine.repairConsistency("spec", specData, schema);

      const validationResult = validationEngine.validateAppSpec(repairedSpec);
      if (!validationResult.valid) {
        throw new Error(`AppSpec validation failed: ${JSON.stringify(validationResult.errors)}`);
      }

      return AppSpecSchema.parse(repairedSpec) as AppSpec;
    } catch (error) {
      console.error("AppSpec generation failed:", error);
      throw error;
    }
  }

  private _emitEvent(event: StageEvent): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }
}
