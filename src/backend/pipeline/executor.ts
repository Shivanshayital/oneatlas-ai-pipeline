import {
  AppIntent,
  DataSchema,
  AppSpec,
  AIMessage,
  JobResult,
  LatencyMetrics,
  AIProvider,
  AIResponse,
  PipelineMetrics,
  PipelineStage,
} from "../types";
import { AIGateway, MODEL_ROUTING } from "../ai/gateway";
import { validationEngine } from "../validation/engine";
import { repairEngine } from "../repair/engine";
import {
  AppIntentSchema,
  DataSchemaSchema,
  AppSpecSchema,
} from "../schemas";
import { extractJSON } from "../utils/json-parser";
import { CostTracker } from "../utils/cost-tracker";
import { jobStore } from "../store/job-store";
import { logger } from "../logging/logger";

// ============================================================================
// System Prompts for Each Stage
// ============================================================================

const INTENT_EXTRACTION_PROMPT = `Extract the app intent from the user's description. Return ONLY valid JSON (no markdown, no explanation).

Return a JSON object with EXACTLY this structure:
{
  "appName": "string (max 200 chars)",
  "appType": "web|mobile|desktop|api|hybrid",
  "features": ["array", "of", "feature", "names"],
  "entities": ["array", "of", "entity", "names"],
  "integrations_requested": ["array", "of", "integration", "ids"],
  "assumptions": ["array", "of", "key", "assumptions"]
}

Rules:
- appName: short, descriptive name for the app
- appType: only one type
- features: 3-10 feature names
- entities: 2-8 entity types (User, Task, Order, etc.)
- integrations_requested: integration IDs from [slack, gmail, whatsapp, stripe, webhook]
- assumptions: reasonable assumptions to proceed

CRITICAL: Return ONLY JSON. No markdown. No explanation. No extra text.`;

const SCHEMA_GENERATION_PROMPT = `Generate a complete data schema based on this app intent. Return ONLY valid JSON (no markdown).

Return a JSON object with EXACTLY this structure:
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

Rules:
- EVERY entity MUST have "id" and "tenantId" fields
- Field types: string, number, boolean, date, timestamp, uuid, json, enum
- Include enum_values for enum type fields
- Relations: from_entity → to_entity with cardinality
- Ensure bidirectional consistency
- Minimum 2 fields per entity (id, tenantId)

CRITICAL: Return ONLY JSON. Every entity MUST have tenantId.`;

const SPEC_GENERATION_PROMPT = `Generate a complete application specification. Return ONLY valid JSON (no markdown).

Return a JSON object with EXACTLY this structure:
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
    "components": ["component1"]
  }],
  "api_endpoints": [{
    "path": "/api/endpoint",
    "method": "GET|POST|PUT|DELETE",
    "entity": "EntityName",
    "auth_required": false,
    "response_type": "json"
  }],
  "auth_rules": [],
  "integration_hooks": [],
  "workflows": [],
  "assumptions": []
}

Rules:
- Paths must start with /
- Every page needs matching API endpoint
- Workflows reference valid entities
- Integration hooks reference valid integrations
- At least 2 pages, 2 API endpoints

CRITICAL: Return ONLY JSON. No markdown. Valid structure.`;

// ============================================================================
// Real Pipeline Execution with Full Observability
// ============================================================================

export class PipelineExecutor {
  private gateway: AIGateway;
  private costTracker: CostTracker;
  private latencyMetrics: LatencyMetrics = {
    intent_stage_ms: 0,
    schema_stage_ms: 0,
    spec_stage_ms: 0,
    total_ms: 0,
  };

  constructor(gateway: AIGateway) {
    this.gateway = gateway;
    this.costTracker = new CostTracker();
  }

  private _updateMetrics(jobId: string): void {
    const totals = this.costTracker.getTotals();
    const repairs = jobStore.getRepairs(jobId);
    const metrics: PipelineMetrics = {
      tokens: {
        input_tokens: totals.total_input_tokens,
        output_tokens: totals.total_output_tokens,
        total_tokens: totals.total_tokens,
        estimated_cost: totals.total_cost_usd,
      },
      latency: this.latencyMetrics,
      repair_attempts: repairs.length,
      successful_repairs: repairs.filter(
        (repair) => repair.outcome === "success" || repair.outcome === "partial"
      ).length,
    };

    jobStore.setMetrics(jobId, metrics);
  }

  private _recordProviderUsage(
    jobId: string,
    stage: PipelineStage,
    provider: AIProvider,
    model: string,
    response: AIResponse,
    attempt: number
  ): void {
    const cost = this.costTracker.recordCost(
      model,
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    jobStore.addProviderUsage(jobId, {
      stage,
      provider,
      model,
      latency_ms: response.latency_ms,
      tokens: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
        estimated_cost: cost,
      },
      cost_usd: cost,
      attempt,
      timestamp: new Date().toISOString(),
    });

    this._updateMetrics(jobId);
  }

  private async _sendWithRetry(
    jobId: string,
    stage: PipelineStage,
    primaryRoute: string,
    fallbackRoute: string,
    messages: AIMessage[],
    temperature: number,
    max_tokens: number
  ): Promise<AIResponse> {
    const routes = [primaryRoute, fallbackRoute];
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < routes.length; attempt += 1) {
      const [provider, model] = routes[attempt].split("/") as [AIProvider, string];
      try {
        const response = await this.gateway.send({
          provider,
          model,
          messages,
          temperature,
          max_tokens,
        });

        this._recordProviderUsage(jobId, stage, provider, model, response, attempt + 1);

        if (attempt > 0) {
          jobStore.addEvent(jobId, {
            type: "stage_retry",
            stage,
            timestamp: new Date().toISOString(),
            data: {
              provider,
              model,
              attempt: attempt + 1,
            },
          });
        }

        return response;
      } catch (error) {
        const errorMessage = String(error);
        jobStore.addRetryHistory(jobId, {
          stage,
          attempt: attempt + 1,
          provider,
          model,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });

        jobStore.addEvent(jobId, {
          type: "stage_retry",
          stage,
          timestamp: new Date().toISOString(),
          data: {
            provider,
            model,
            attempt: attempt + 1,
            error: errorMessage,
          },
          error: errorMessage,
        });

        lastError = error as Error;
      }
    }

    throw lastError ?? new Error("Unknown gateway failure");
  }

  async executePipeline(jobId: string, prompt: string): Promise<void> {
    const totalStartTime = Date.now();

    try {
      jobStore.updateJobStatus(jobId, "processing");

      // Stage 1: Intent Extraction
      const intentStartTime = Date.now();
      const intent = await this._executeIntentStage(jobId, prompt);
      this.latencyMetrics.intent_stage_ms = Date.now() - intentStartTime;

      // Stage 2: Schema Generation
      const schemaStartTime = Date.now();
      const schema = await this._executeSchemaStage(jobId, intent, prompt);
      this.latencyMetrics.schema_stage_ms = Date.now() - schemaStartTime;

      // Stage 3: AppSpec Generation
      const specStartTime = Date.now();
      const spec = await this._executeSpecStage(jobId, intent, schema, prompt);
      this.latencyMetrics.spec_stage_ms = Date.now() - specStartTime;

      this.latencyMetrics.total_ms = Date.now() - totalStartTime;

      // Store result
      const result: JobResult = {
        intent,
        schema,
        spec,
        repairs_applied: jobStore.getRepairs(jobId),
      };

      jobStore.setJobResult(jobId, result);

      jobStore.addEvent(jobId, {
        type: "generation_complete",
        stage: "complete",
        timestamp: new Date().toISOString(),
        data: {
          metrics: {
            latency: this.latencyMetrics,
            tokens: this.costTracker.getTotals(),
          },
        },
      });

      logger.info("Pipeline execution completed", {
        jobId,
        totalTime: this.latencyMetrics.total_ms,
        cost: this.costTracker.getTotals().total_cost_usd,
      });
    } catch (error) {
      const errorMsg = String(error);
      jobStore.setJobError(jobId, errorMsg);
      jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "failed",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });

      logger.error("Pipeline execution failed", error as Error, { jobId });
    }
  }

  private async _executeIntentStage(jobId: string, prompt: string): Promise<AppIntent> {
    jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "intent",
      timestamp: new Date().toISOString(),
    });

    try {
      const primaryRoute = MODEL_ROUTING.intent.primary;
      const fallbackRoute = MODEL_ROUTING.intent.fallback;
      const [primaryProvider, primaryModel] = primaryRoute.split("/") as [AIProvider, string];

      jobStore.addEvent(jobId, {
        type: "stage_start",
        stage: "intent",
        timestamp: new Date().toISOString(),
        data: {
          provider: primaryProvider,
          model: primaryModel,
        },
      });

      const response = await this._sendWithRetry(
        jobId,
        "intent",
        primaryRoute,
        fallbackRoute,
        [
          { role: "system", content: INTENT_EXTRACTION_PROMPT },
          { role: "user", content: prompt },
        ],
        0.3,
        1024
      );

      // Extract JSON with repairs
      const extractResult = extractJSON(response.content);

      if (!extractResult.success || extractResult.data === null) {
        throw new Error(`Failed to extract JSON: ${extractResult.error}`);
      }

      const intentSource = extractResult.data as Record<string, unknown>;

      // Apply repairs
      const requiredFields = [
        "appName",
        "appType",
        "features",
        "entities",
        "integrations_requested",
        "assumptions",
      ];
      const { data: repairedData, logs: repairLogs } = repairEngine.repairFields(
        "intent",
        intentSource,
        requiredFields
      );

      for (const log of repairLogs) {
        jobStore.addRepair(jobId, log);
      }

      // Validate
      const validationResult = validationEngine.validateAppIntent(repairedData);
      jobStore.addValidationSnapshot(jobId, {
        stage: "intent",
        valid: validationResult.valid,
        errors: validationResult.errors,
        timestamp: new Date().toISOString(),
      });

      if (!validationResult.valid) {
        throw new Error(
          `Intent validation failed: ${JSON.stringify(validationResult.errors)}`
        );
      }

      const intent = AppIntentSchema.parse(repairedData) as AppIntent;
      jobStore.setStageOutput(jobId, "intent", intent);

      jobStore.addEvent(jobId, {
        type: "stage_complete",
        stage: "intent",
        timestamp: new Date().toISOString(),
        data: { intent },
      });

      return intent;
    } catch (error) {
      const errorMsg = String(error);
      jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "intent",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
      throw error;
    }
  }

  private async _executeSchemaStage(
    jobId: string,
    intent: AppIntent,
    prompt: string
  ): Promise<DataSchema> {
    jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "schema",
      timestamp: new Date().toISOString(),
    });

    try {
      const primaryRoute = MODEL_ROUTING.schema.primary;
      const fallbackRoute = MODEL_ROUTING.schema.fallback;
      const [primaryProvider, primaryModel] = primaryRoute.split("/") as [AIProvider, string];

      const intentSummary = `App: ${intent.appName}\nType: ${intent.appType}\nFeatures: ${intent.features.join(", ")}\nEntities: ${intent.entities.join(", ")}`;

      jobStore.addEvent(jobId, {
        type: "stage_start",
        stage: "schema",
        timestamp: new Date().toISOString(),
        data: {
          provider: primaryProvider,
          model: primaryModel,
        },
      });

      const response = await this._sendWithRetry(
        jobId,
        "schema",
        primaryRoute,
        fallbackRoute,
        [
          { role: "system", content: SCHEMA_GENERATION_PROMPT },
          {
            role: "user",
            content: `Original user request: "${prompt}"\n\nExtracted intent:\n${intentSummary}`,
          },
        ],
        0.4,
        2048
      );

      const extractResult = extractJSON(response.content);
      if (!extractResult.success || extractResult.data === null) {
        throw new Error(`Failed to extract schema JSON: ${extractResult.error}`);
      }

      const schemaData = extractResult.data as Record<string, unknown>;

      // Ensure every entity has tenantId
      if (schemaData.entities && Array.isArray(schemaData.entities)) {
        for (const entity of schemaData.entities as any[]) {
          if (!entity.fields) entity.fields = [];

          // Add id if missing
          if (!entity.fields.find((f: any) => f.name === "id")) {
            entity.fields.unshift({
              name: "id",
              type: "uuid",
              required: true,
            });
          }

          // Add tenantId if missing
          if (!entity.fields.find((f: any) => f.name === "tenantId")) {
            entity.fields.splice(1, 0, {
              name: "tenantId",
              type: "uuid",
              required: true,
            });
          }
        }
      }

      const validationResult = validationEngine.validateDataSchema(schemaData);
      jobStore.addValidationSnapshot(jobId, {
        stage: "schema",
        valid: validationResult.valid,
        errors: validationResult.errors,
        timestamp: new Date().toISOString(),
      });

      if (!validationResult.valid) {
        throw new Error(
          `Schema validation failed: ${JSON.stringify(validationResult.errors)}`
        );
      }

      const schema = DataSchemaSchema.parse(schemaData) as DataSchema;
      jobStore.setStageOutput(jobId, "schema", schema);

      jobStore.addEvent(jobId, {
        type: "stage_complete",
        stage: "schema",
        timestamp: new Date().toISOString(),
        data: { entity_count: schema.entities.length },
      });

      return schema;
    } catch (error) {
      const errorMsg = String(error);
      jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "schema",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
      throw error;
    }
  }

  private async _executeSpecStage(
    jobId: string,
    intent: AppIntent,
    schema: DataSchema,
    prompt: string
  ): Promise<AppSpec> {
    jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "spec",
      timestamp: new Date().toISOString(),
    });

    try {
      const primaryRoute = MODEL_ROUTING.spec.primary;
      const fallbackRoute = MODEL_ROUTING.spec.fallback;
      const [primaryProvider, primaryModel] = primaryRoute.split("/") as [AIProvider, string];

      const schemaJson = JSON.stringify(schema, null, 2);

      jobStore.addEvent(jobId, {
        type: "stage_start",
        stage: "spec",
        timestamp: new Date().toISOString(),
        data: {
          provider: primaryProvider,
          model: primaryModel,
        },
      });

      const response = await this._sendWithRetry(
        jobId,
        "spec",
        primaryRoute,
        fallbackRoute,
        [
          { role: "system", content: SPEC_GENERATION_PROMPT },
          {
            role: "user",
            content: `Original request: "${prompt}"\n\nSchema to implement:\n${schemaJson}`,
          },
        ],
        0.4,
        4096
      );

      const extractResult = extractJSON(response.content);
      if (!extractResult.success || extractResult.data === null) {
        throw new Error(`Failed to extract spec JSON: ${extractResult.error}`);
      }

      const specData = extractResult.data as Record<string, unknown>;

      // Ensure metadata
      if (!specData.metadata) {
        specData.metadata = {
          app_name: intent.appName,
          app_type: intent.appType,
          version: "1.0.0",
          created_at: new Date().toISOString(),
        };
      }

      // Ensure schema is included
      specData.data_schema = schema;

      // Repair consistency
      const { data: repairedSpec, logs: repairLogs } = repairEngine.repairConsistency(
        "spec",
        specData,
        schema
      );

      for (const log of repairLogs) {
        jobStore.addRepair(jobId, log);
      }

      const validationResult = validationEngine.validateAppSpec(repairedSpec);
      jobStore.addValidationSnapshot(jobId, {
        stage: "spec",
        valid: validationResult.valid,
        errors: validationResult.errors,
        timestamp: new Date().toISOString(),
      });

      if (!validationResult.valid) {
        throw new Error(
          `AppSpec validation failed: ${JSON.stringify(validationResult.errors)}`
        );
      }

      const spec = AppSpecSchema.parse(repairedSpec) as AppSpec;
      jobStore.setStageOutput(jobId, "spec", spec);

      jobStore.addEvent(jobId, {
        type: "stage_complete",
        stage: "spec",
        timestamp: new Date().toISOString(),
        data: {
          pages: spec.pages.length,
          endpoints: spec.api_endpoints.length,
          workflows: spec.workflows.length,
        },
      });

      return spec;
    } catch (error) {
      const errorMsg = String(error);
      jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "spec",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
      throw error;
    }
  }

}
