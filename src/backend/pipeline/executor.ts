import {
  AppIntent,
  DataSchema,
  DataEntity,
  AppSpec,
  AIMessage,
  JobResult,
  TokenMetrics, // Import TokenMetrics
  LatencyMetrics,
  AIProvider,
  AIResponse,
  PipelineMetrics, // Keep PipelineMetrics
  DataField, // Import DataField for fallback entity generation
  PipelineStage,
} from "../types/index";
import { AIGateway, MODEL_ROUTING, getModelHealthScore, resolveProviderAndModel } from "../ai/gateway";
import { validationEngine } from "../validation/engine";

import { repairEngine } from "../repair/engine";
import {
  AppIntentSchema,
  // DataSchemaSchema, // Not directly used here, but in _executeSchemaStage
  DataSchemaSchema,
  AppSpecSchema,
} from "../schemas";
import { extractJSON } from "../utils/json-repair";
import { CostTracker } from "../ai/cost-tracker";
import { jobStore } from "../store/job-store";
import { logger } from "../logging/logger";
import {
  getIntegration,
  validateIntegrationAction,
  // validateIntegrationTrigger, // Not directly used here
  validateIntegrationTrigger,
} from "../integrations/registry";

// ============================================================================
// System Prompts for Each Stage
// ============================================================================
const COMPACT_JSON_MODE = "Return minified JSON only. No markdown, no explanations.";

const INTENT_EXTRACTION_PROMPT = `Extract app intent. ${COMPACT_JSON_MODE}
Output: {"appName":"string","appType":"crm|project_management|ecommerce|hr_tool|inventory|analytics|custom","features":["strings"],"entities":["strings"],"integrations_requested":["slack|gmail|whatsapp|stripe|webhook"],"assumptions":["strings"]}`;

const SCHEMA_GENERATION_PROMPT = `Generate data schema. ${COMPACT_JSON_MODE}

Required:
- Every entity MUST include:
  - id (uuid)
  - tenantId (uuid)

Allowed field types ONLY:
- string
- number
- boolean
- date
- timestamp
- uuid
- json
- enum

NEVER use:
- datetime
- integer
- float
- object
- array

Return STRICT valid JSON only.

Structure:
{
  "schema_version":"1.0.0",
  "entities":[
    {
      "name":"String",
      "tableName":"string",
      "fields":[
        {
          "name":"string",
          "type":"string",
          "required":true
        }
      ],
      "relations":[]
    }
  ]
}`;

// Shorter, more direct prompts to reduce token usage and processing time
const SPEC_PART_META_PROMPT = `Generate AppSpec metadata and pages. JSON: {"metadata":{"app_name":"str","app_type":"str"},"pages":[{"name":"str","path":"/str","title":"str","requires_auth":bool,"components":["str"]}],"auth_rules":[]}`;

const SPEC_PART_ENDPOINTS_PROMPT = `Generate API endpoints for schema. JSON: {"api_endpoints":[{"path":"/api/str","method":"GET|POST|PUT|DELETE","entity":"str","auth_required":bool,"response_type":"json"}]}`;

const SPEC_PART_FLOWS_PROMPT = `Generate workflows for schema. JSON: {"integration_hooks":[{"integration_id":"str","trigger":"str","action":"str"}],"workflows":[{"name":"str","trigger_type":"event","trigger_entity":"str","steps":[]}],"assumptions":[]}`;

const MAX_EXECUTOR_PROVIDER_ATTEMPTS = 3; // 1 initial + 2 retries max
// COMMENT: Free models on OpenRouter can have unpredictable latency due to queuing.
// 30s is a safer window for structured JSON generation involving multiple sequential LLM calls.
// Partial recovery ensures the pipeline doesn't hard-fail if only one section (e.g., flows) hangs.
const APP_SPEC_STAGE_TIMEOUT_MS = 30_000; 

const PROMPT_TRIM_THRESHOLD = 3000; // Max characters for prompt context

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

  /**
   * Token guardrail: Trims prompt context if it exceeds safety limits
   */
  private _trimPromptContext(text: string): string {
    if (text.length <= PROMPT_TRIM_THRESHOLD) return text;
    logger.warn(`[Executor] Prompt exceeds threshold (${text.length} chars). Trimming context.`);
    return text.substring(0, PROMPT_TRIM_THRESHOLD) + "... [truncated]";
  }

  /**
   * Helper to slugify a string and pluralize it for use as a table name.
   * @param name The singular entity name.
   * @returns A slugified and pluralized string.
   */
  private _slugifyAndPluralize(name: string): string {
    // Convert to lowercase and replace spaces with underscores
    const slug = name.toLowerCase().replace(/\s+/g, '_');
    // Simple pluralization: add 's' if not already ending in 's'
    return slug.endsWith('s') ? slug : slug + 's';
  }
  private async _updateMetrics(jobId: string): Promise<void> {
    const totals = this.costTracker.getTotals();
    const state = await jobStore.getJob(jobId);
    if (!state) return; // Guard against state loss during long serverless execution

    const repairs = state.repairs;
    const metrics: PipelineMetrics = {
      tokens: {
        input_tokens: totals.input_tokens,
        output_tokens: totals.output_tokens,
        total_tokens: totals.total_tokens,
        estimated_cost: totals.estimated_cost, // Use the standard TokenMetrics
      },
      latency: this.latencyMetrics,
      repair_attempts: repairs.length,
      successful_repairs: repairs.filter(
        (repair) => repair.outcome === "success" || repair.outcome === "partial"
      ).length,
    };

    await jobStore.setMetrics(jobId, metrics);
  }

  private async _recordProviderUsage(
    jobId: string,
    stage: PipelineStage,
    provider: AIProvider,
    model: string,
    response: AIResponse,
    attempt: number
  ): Promise<void> {
    const cost = this.costTracker.recordCost(
      `${provider}/${model}`,
      response.usage.input_tokens,
      response.usage.output_tokens
    );

    const providerUsage = {
      stage,
      provider,
      model,
      latency_ms: response.latency_ms,
      tokens: {
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        total_tokens: response.usage.total_tokens,
        estimated_cost: cost, // Use the standard TokenMetrics
      },
      cost_usd: cost,
      attempt,
      timestamp: new Date().toISOString(),
      health_status: "active" as const,
      health_score: getModelHealthScore(provider, model),
      retry_count: Math.max(0, attempt - 1),
    };

    await jobStore.addProviderUsage(jobId, providerUsage);

    // Emit a lightweight provider usage event for live SSE consumption
    try {
      await jobStore.addEvent(jobId, {
        type: "stage_provider_usage",
        stage,
        timestamp: new Date().toISOString(),
        data: {
          provider_usage: providerUsage,
        },
      });
    } catch (err) {
      // Don't let SSE failures block pipeline
      logger.warn("Failed to emit provider usage event", { error: String(err) });
    }

    await this._updateMetrics(jobId);
  }

  private async _sendWithRetry( // Explicit return type
    jobId: string,
    stage: PipelineStage,
    messages: AIMessage[],
    temperature: number,
    max_tokens: number,
    abortSignal?: AbortSignal
  ): Promise<AIResponse> { // Explicit return type
    const modelRoutingConfig = MODEL_ROUTING[stage as keyof typeof MODEL_ROUTING];
    interface RoutingConfig {
  primary: string;
  fallback?: string;
  secondaryFallback?: string;
  tertiaryFallback?: string;
};
const typedRoutingConfig = modelRoutingConfig as RoutingConfig;

const routes = [
  typedRoutingConfig.primary,
  typedRoutingConfig.fallback,
  typedRoutingConfig.secondaryFallback,
  typedRoutingConfig.tertiaryFallback,
].filter((r): r is string => typeof r === "string");
    let lastError: Error | null = null;
    const attemptedRoutes = new Set<string>();

    const maxAttempts = Math.min(routes.length, MAX_EXECUTOR_PROVIDER_ATTEMPTS); // Limit to 3 attempts (initial + 2 retries)

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      if (abortSignal?.aborted) {
        throw new Error(`Stage ${stage} aborted after timeout`);
      }

      const route = routes[attempt];
      // Use the new helper function to resolve provider and model
      const { provider, model } = resolveProviderAndModel(route);
      const routeKey = `${provider}/${model}`; // Track attempted routes to avoid redundant calls
      if (attemptedRoutes.has(routeKey)) {
        continue;
      }
      attemptedRoutes.add(routeKey);

      logger.info(`[Executor] Attempting stage ${stage} (attempt ${attempt + 1}) using ${provider}/${model}`);

      try {
        const response = await this.gateway.send({
          provider, // The actual provider to use
          model, // The actual model to use
          messages,
          temperature,
          max_tokens,
          stage, // Pass stage to gateway for more granular fallback logic
          abortSignal,
        });

        const effectiveAttempt = response.provider === provider ? attempt + 1 : attempt + 2;

        await this._recordProviderUsage(
          jobId,
          stage,
          response.provider,
          response.model,
          response,
          effectiveAttempt
        );

        if (attempt > 0 || response.provider !== provider) {
          await jobStore.addEvent(jobId, {
            type: "stage_retry",
            stage,
            timestamp: new Date().toISOString(),
            data: {
              provider: response.provider,
              model: response.model,
              requested_provider: provider,
              requested_model: model,
              attempt: effectiveAttempt,
              fallback_used: response.provider !== provider,
            },
          });
        }

        logger.info(`[Executor] Successfully completed stage ${stage} with ${response.provider}/${response.model}`);
        return response;
      } catch (error) {
        const errorMessage = String(error);
        logger.warn(`[Executor] Stage ${stage} failed with ${provider}/${model}: ${errorMessage}. Trying fallback...`, {
          jobId,
          attempt: attempt + 1,
          maxAttempts,
        });

        await jobStore.addRetryHistory(jobId, {
          stage,
          attempt: attempt + 1,
          provider,
          model,
          error: errorMessage,
          timestamp: new Date().toISOString(),
        });

        await jobStore.addEvent(jobId, {
          type: "stage_retry",
          stage,
          timestamp: new Date().toISOString(),
          provider,
          model,
          data: {
            provider,
            model,
            attempt: attempt + 1,
            max_attempts: maxAttempts,
            error: errorMessage,
          },
          error: errorMessage,
        });

        lastError = error as Error;
        
        // Retry cooldown: small backoff to avoid hammering same failing endpoint
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }

    throw lastError ?? new Error(`Unknown gateway failure after ${maxAttempts} attempts`);
  }

  async executePipeline(jobId: string, prompt: string): Promise<void> { // Explicit return type
    const totalStartTime = Date.now();
    let intent: AppIntent | undefined;
    let schema: DataSchema | undefined;
    let spec: AppSpec | undefined;
    
    const state = await jobStore.getJob(jobId);
    if (!state) {
      logger.error(`[Executor] Aborting execution: Job ${jobId} not found in store`);
      return;
    }

    try {
      await jobStore.updateJobStatus(jobId, "processing");
      logger.info(`[Executor] Beginning pipeline stages for: ${jobId}`);

      // Stage 1: Intent Extraction
      const intentStartTime = Date.now();
      intent = await this._executeIntentStage(jobId, prompt);
      this.latencyMetrics.intent_stage_ms = Date.now() - intentStartTime;

      // Stage 2: Schema Generation
      const schemaStartTime = Date.now();
      schema = await this._executeSchemaStage(jobId, intent, prompt);
      this.latencyMetrics.schema_stage_ms = Date.now() - schemaStartTime;

      // Stage 3: AppSpec Generation
      const specStartTime = Date.now();
      spec = await this._executeSpecStage(jobId, intent, schema, prompt);
      this.latencyMetrics.spec_stage_ms = Date.now() - specStartTime;

      this.latencyMetrics.total_ms = Date.now() - totalStartTime;

      // Store result
      const result: JobResult = {
        intent,
        schema,
        spec,
        repairs_applied: await jobStore.getRepairs(jobId),
      };

      await jobStore.setJobResult(jobId, result);

      const totals = this.costTracker.getTotals();
      await jobStore.addEvent(jobId, {
        type: "generation_complete",
        stage: "complete",
        timestamp: new Date().toISOString(),
        data: {
          metrics: {
            latency: this.latencyMetrics,
            tokens: totals as TokenMetrics, // Cast to TokenMetrics
          },
        },
      });

      await this._updateMetrics(jobId);

      logger.info("Pipeline execution completed", {
        jobId,
        totalTime: this.latencyMetrics.total_ms,
        cost: this.costTracker.getTotals().estimated_cost,
      });
    } catch (error) {
      const errorMsg = String(error);
      await jobStore.setJobError(jobId, errorMsg);
      await jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "failed",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });

      logger.error("Pipeline execution failed", error as Error, { jobId });
    }
  }

  private async _executeIntentStage(jobId: string, prompt: string): Promise<AppIntent> { // Explicit return type
    await jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "intent",
      timestamp: new Date().toISOString(),
    });
    const stageStartTime = Date.now();

    try {
      const modelRoutingConfig = MODEL_ROUTING.intent;

      await jobStore.addEvent(jobId, {
        type: "stage_start",
        stage: "intent",
        timestamp: new Date().toISOString(),
        data: {
          ...resolveProviderAndModel(modelRoutingConfig.primary),
        },
      });

      const response = await this._sendWithRetry(
        jobId,
        "intent",
        [
          { role: "system", content: INTENT_EXTRACTION_PROMPT },
          { role: "user", content: prompt },
        ],
        0.2, // Low temperature for factual extraction
        500 // Max tokens for intent extraction
      );

      // Extract JSON with repairs
      const extractResult = extractJSON(response.content);

      if (!extractResult.success || extractResult.data === null) {
        throw new Error(`Failed to extract JSON: ${extractResult.error}`);
      }

      const intentSource = extractResult.data as Record<string, unknown>;
      intentSource.appType = this._normalizeAppType(prompt, String(intentSource.appType ?? ""));
      const intentRepair = repairIntentData(intentSource, prompt);
      // Apply deterministic repairs from repairIntentData
      Object.assign(intentSource, intentRepair.data);

      for (const log of intentRepair.logs) {
        await jobStore.addRepair(jobId, log);
      }

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

      for (const log of repairLogs) { // Log field repairs
        await jobStore.addRepair(jobId, log);
      }

      // Validate
      const validationResult = validationEngine.validateAppIntent(repairedData);
      await jobStore.addValidationSnapshot(jobId, {
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
      // Persist output immediately to survive instance transitions
      await jobStore.setStageOutput(jobId, "intent", intent); 

      await jobStore.addEvent(jobId, {
        type: "stage_complete",
        stage: "intent",
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - stageStartTime,
        data: { intent },
      });

      return intent;
    } catch (error) {
      const errorMsg = String(error);
      await jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "intent",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
      throw error;
    }
  }

  /**
   * Generates a minimal fallback DataEntity based on the app intent.
   * This is used when the AI model fails to produce a valid or non-empty schema.
   * @param intent The extracted AppIntent.
   * @returns A DataEntity object.
   */
  // COMMENT: Free models, especially smaller ones, can sometimes struggle with complex JSON structures
  // and might return empty arrays or incomplete objects, leading to validation failures.
  // This fallback mechanism ensures that the pipeline can recover from such cases by
  // deterministically generating a minimal, valid schema based on the extracted intent.
  // This improves the overall reliability and stability of the generation process,
  // preventing hard failures and allowing the pipeline to continue with a usable (though basic) output.
  // This "repair-first" architecture is crucial in LLM systems to handle model imperfections gracefully.
  private _generateFallbackEntity(intent: AppIntent): DataEntity {
    let entityName = "Item";
    const additionalFields: DataField[] = [];

    const promptContext = `${intent.appName.toLowerCase()} ${intent.features.join(" ").toLowerCase()} ${intent.entities.join(" ").toLowerCase()}`;

    // Prioritize direct keyword matches from prompt context or appType
    if (promptContext.includes("todo") || promptContext.includes("task") || intent.appType === "project_management") {
      entityName = "Task";
      additionalFields.push({ name: "title", type: "string", required: true });
      additionalFields.push({ name: "status", type: "enum", enum_values: ["todo", "in_progress", "done"], required: true });
    } else if (promptContext.includes("ecommerce") || promptContext.includes("product") || promptContext.includes("order") || promptContext.includes("shop") || intent.appType === "ecommerce") {
      entityName = "Product";
      additionalFields.push({ name: "name", type: "string", required: true });
      additionalFields.push({ name: "price", type: "number", required: true });
    } else if (promptContext.includes("chat") || promptContext.includes("message")) {
      entityName = "Message";
      additionalFields.push({ name: "content", type: "string", required: true });
      additionalFields.push({ name: "senderId", type: "uuid", required: true });
    } else if (promptContext.includes("crm") || promptContext.includes("customer") || intent.appType === "crm") {
      entityName = "Customer";
      additionalFields.push({ name: "name", type: "string", required: true });
      additionalFields.push({ name: "email", type: "string", required: false });
    } else if (promptContext.includes("blog") || promptContext.includes("post")) {
      entityName = "Post";
      additionalFields.push({ name: "title", type: "string", required: true });
      additionalFields.push({ name: "content", type: "string", required: true });
    } else {
      // Default to generic "Item" if nothing else matches
      entityName = "Item";
      additionalFields.push({ name: "name", type: "string", required: true });
    }

    // Ensure basic required fields are always present
    const baseFields: DataField[] = [
      { name: "id", type: "uuid", required: true },
      { name: "tenantId", type: "uuid", required: true },
      { name: "createdAt", type: "timestamp", required: true },
      { name: "updatedAt", type: "timestamp", required: true },
    ];

    // Combine base fields with additional fields, avoiding duplicates by name
    const fieldsMap = new Map<string, DataField>();
    [...baseFields, ...additionalFields].forEach(field => {
      fieldsMap.set(field.name, field);
    });

    return {
      name: entityName,
      tableName: this._slugifyAndPluralize(entityName),
      fields: Array.from(fieldsMap.values()),
      relations: [],
      description: `Fallback entity generated due to empty schema from AI for a ${intent.appType} app.`,
    };
  }

  private async _executeSchemaStage( // Explicit return type
    jobId: string,
    intent: AppIntent,
    prompt: string
  ): Promise<DataSchema> {
    await jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "schema",
      timestamp: new Date().toISOString(),
    });
    const stageStartTime = Date.now();

    try {
      const modelRoutingConfig = MODEL_ROUTING.schema;

      const intentSummary = `App: ${intent.appName}\nType: ${intent.appType}\nFeatures: ${intent.features.join(", ")}\nEntities: ${intent.entities.join(", ")}`;

      await jobStore.addEvent(jobId, {
        type: "stage_start",
        stage: "schema",
        timestamp: new Date().toISOString(),
        data: {
          ...resolveProviderAndModel(modelRoutingConfig.primary),
        },
      });

      const response = await this._sendWithRetry(
        jobId,
        "schema",
        [
          { role: "system", content: SCHEMA_GENERATION_PROMPT },
          {
            role: "user",
            content: `Original user request: "${prompt}"\n\nExtracted intent:\n${intentSummary}`,
          },
        ],
        0.3, // Moderate temperature for schema generation
        500 // Max tokens for schema generation
      );

      const extractResult = extractJSON(response.content);
      if (!extractResult.success || extractResult.data === null) {
        // COMMENT: If the model fails to return valid JSON, it's a structural issue.
        // The extractJSON utility attempts to repair common JSON malformations.
        throw new Error(`Failed to extract schema JSON: ${extractResult.error}`);
      }

      const schemaData = extractResult.data as Record<string, unknown>;

      // COMMENT: Free models, especially smaller ones, can sometimes struggle with complex JSON structures
      // and might return empty arrays or incomplete objects, leading to validation failures.
      // This fallback mechanism ensures that the pipeline can recover from such cases by
      // deterministically generating a minimal, valid schema based on the extracted intent.
      // This improves the overall reliability and stability of the generation process,
      // preventing hard failures and allowing the pipeline to continue with a usable (though basic) output.
      // This "repair-first" architecture is crucial in LLM systems to handle model imperfections gracefully.
      if (!schemaData.entities || (Array.isArray(schemaData.entities) && schemaData.entities.length === 0)) {
        logger.warn(`[Executor] Schema generation returned empty entities. Applying fallback entity generation.`, { jobId });
        const fallbackEntity = this._generateFallbackEntity(intent);
        schemaData.entities = [fallbackEntity];

        await jobStore.addRepair(jobId, {
          timestamp: new Date().toISOString(),
          stage: "schema",
          strategy: "field_repair",
          error: "Schema entities array was empty or missing.",
          action: `Generated fallback entity '${fallbackEntity.name}' based on app intent.`,
          outcome: "partial",
          details: { generated_entity: fallbackEntity.name },
        });
      }

// ============================================================================
// FIELD TYPE NORMALIZATION
// ============================================================================

const TYPE_NORMALIZATION: Record<
  string,
  "string" | "number" | "boolean" | "timestamp" | "json" | "date" | "uuid" | "enum"
> = {
  datetime: "timestamp",
  integer: "number",
  float: "number",
  object: "json",
  array: "json",
};

// Normalize invalid field types returned by LLMs
if (
  schemaData.entities &&
  Array.isArray(schemaData.entities)
) {
  for (const entity of schemaData.entities as DataEntity[]) {
    if (!Array.isArray(entity.fields)) continue;

    for (const field of entity.fields) {
      const rawType = String(field.type).toLowerCase();

      field.type =
  TYPE_NORMALIZATION[rawType] ??
  (rawType as
    | "string"
    | "number"
    | "boolean"
    | "timestamp"
    | "json"
    | "date"
    | "uuid"
    | "enum");
    }
  }
}

      // Ensure every entity has tenantId
      if (schemaData.entities && Array.isArray(schemaData.entities)) { // Type guard
        for (const entity of schemaData.entities as DataEntity[]) { // Explicit type for entity
          if (!entity.fields) entity.fields = [];
          
          // Add id if missing
          if (!entity.fields.find((field) => field.name === "id")) {
            entity.fields.unshift({
              name: "id",
              type: "uuid",
              required: true,
            });
          }

          // Add tenantId if missing (ensure it's not already there)
          if (!entity.fields.find((field) => field.name === "tenantId")) {
            entity.fields.splice(1, 0, {
              name: "tenantId",
              type: "uuid",
              required: true,
            });
          }
        }
      }

      const { data: repairedSchemaData, logs: repairLogs } = repairEngine.repairFields(
        "schema",
        schemaData,
        ["schema_version", "entities"]
      );

      for (const log of repairLogs) { // Log field repairs
        await jobStore.addRepair(jobId, log);
      }

      const validationResult = validationEngine.validateDataSchema(repairedSchemaData);
      await jobStore.addValidationSnapshot(jobId, {
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

      const schema = DataSchemaSchema.parse(repairedSchemaData) as DataSchema;
      // Persist output immediately
      await jobStore.setStageOutput(jobId, "schema", schema);

      await jobStore.addEvent(jobId, {
        type: "stage_complete",
        stage: "schema",
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - stageStartTime,
        data: { entity_count: schema.entities.length },
      });

      return schema;
    } catch (error) {
      const errorMsg = String(error);
      await jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "schema",
        timestamp: new Date().toISOString(),
        error: errorMsg,
      });
      throw error;
    }
  }

  private async _executeSpecStage( // Explicit return type
    jobId: string,
    intent: AppIntent,
    schema: DataSchema,
    prompt: string
  ): Promise<AppSpec> {
    await jobStore.addEvent(jobId, {
      type: "stage_start",
      stage: "spec",
      timestamp: new Date().toISOString(),
    });
    const stageStartTime = Date.now();
    const controller = new AbortController();
    let didTimeout = false;
    let sectionMeta: Record<string, unknown> = {};
    let sectionEndpoints: Record<string, unknown> = {};
    let sectionFlows: Record<string, unknown> = {};
    const timeoutId = setTimeout(() => {
      didTimeout = true;
      logger.warn("AppSpec timeout", {
        jobId,
        timeoutMs: APP_SPEC_STAGE_TIMEOUT_MS,
      });
      controller.abort(); // Abort the ongoing fetch requests
    }, APP_SPEC_STAGE_TIMEOUT_MS);

    try {
      const schemaJson = JSON.stringify(schema, null, 2);
      
      // PARTIAL CHUNKING: Metadata, Endpoints, and Flows generated separately to save tokens
      sectionMeta = await this._executeSpecSection(jobId, "meta", SPEC_PART_META_PROMPT, prompt, schemaJson, controller.signal);
      sectionEndpoints = await this._executeSpecSection(jobId, "endpoints", SPEC_PART_ENDPOINTS_PROMPT, prompt, schemaJson, controller.signal); // Max tokens 500
      sectionFlows = await this._executeSpecSection(jobId, "flows", SPEC_PART_FLOWS_PROMPT, prompt, schemaJson, controller.signal); // Max tokens 500
      
      const specData: Record<string, unknown> = {
        ...sectionMeta,
        ...sectionEndpoints,
        ...sectionFlows,
        data_schema: schema
      };

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

      const { data: fieldRepairedSpec, logs: fieldRepairLogs } = repairEngine.repairFields(
        "spec",
        specData,
        ["metadata", "data_schema", "pages", "api_endpoints", "auth_rules"]
      );

      for (const log of fieldRepairLogs) {
        await jobStore.addRepair(jobId, log);
      }

      this._ensureMinimumSpec(fieldRepairedSpec, intent, schema);
      this._coerceSpecCollections(fieldRepairedSpec, intent, schema);

      // Consistency repair (Max 1 pass as requested)
      const { data: repairedSpec, logs: repairLogs } = repairEngine.repairConsistency(
        "spec",
        fieldRepairedSpec,
        schema
      );

      for (const log of repairLogs) { // Log consistency repairs
        await jobStore.addRepair(jobId, log);
      }

      const validationResult = validationEngine.validateAppSpec(repairedSpec);
      await jobStore.addValidationSnapshot(jobId, {
        stage: "spec",
        valid: validationResult.valid,
        errors: validationResult.errors,
        timestamp: new Date().toISOString(),
      });

      // If validation fails after initial generation and repairs, apply deterministic coercions and re-validate
      if (!validationResult.valid) {
        logger.warn("AppSpec validation failed after LLM generation; applying final deterministic fallback", {
          jobId,
          errors: validationResult.errors,
        });
        this._coerceSpecCollections(repairedSpec, intent, schema);
        this._ensureMinimumSpec(repairedSpec, intent, schema);
        const secondPass = validationEngine.validateAppSpec(repairedSpec);
        await jobStore.addValidationSnapshot(jobId, {
          stage: "spec",
          valid: secondPass.valid,
          errors: secondPass.errors,
          timestamp: new Date().toISOString(),
        });
        if (!secondPass.valid) {
          throw new Error(
            `AppSpec validation failed: ${JSON.stringify(secondPass.errors)}`
          );
        }
      }

      const spec = AppSpecSchema.parse(repairedSpec) as AppSpec;
      // Persist output immediately
      await jobStore.setStageOutput(jobId, "spec", spec);

      await jobStore.addEvent(jobId, {
        // Emit completion event with key metrics
        type: "stage_complete",
        stage: "spec",
        timestamp: new Date().toISOString(),
        latency_ms: Date.now() - stageStartTime,
        data: {
          pages: spec.pages.length,
          endpoints: spec.api_endpoints.length,
          workflows: spec.workflows.length,
        },
      });

      logger.info("Stage completion", {
        jobId,
        stage: "spec",
        latencyMs: Date.now() - stageStartTime,
      });

      return spec;
    } catch (error) {
      const elapsed = Date.now() - stageStartTime;
      const timedOut = didTimeout || controller.signal.aborted;
      
      // Classify timeout for better observability
      let timeoutType: 'generation' | 'provider' | 'network' = 'generation';
      const errorStr = String(error).toLowerCase();
      if (errorStr.includes('fetch') || errorStr.includes('network')) {
        timeoutType = 'network';
      } else if (errorStr.includes('gateway') || errorStr.includes('provider')) {
        timeoutType = 'provider';
      }

      const errorMsg = timedOut
        ? `AppSpec stage exceeded ${APP_SPEC_STAGE_TIMEOUT_MS}ms (${timeoutType} timeout)`
        : String(error);

      logger.warn(`[Executor] Spec stage failure. Elapsed: ${elapsed}ms. Type: ${timeoutType}`, { jobId, timedOut });

      if (timedOut) {
        // If timeout, build and save a partial spec
        const partialSpec = this._buildPartialSpec(intent, schema, {
          ...sectionMeta,
          ...sectionEndpoints,
          ...sectionFlows,
        });
        await jobStore.setStageOutput(jobId, "spec", partialSpec);
        await jobStore.setPartialJobResult(jobId, {
          intent,
          schema,
          spec: partialSpec,
          repairs_applied: await jobStore.getRepairs(jobId),
        });

        await jobStore.addRepair(jobId, {
          timestamp: new Date().toISOString(),
          stage: "spec",
          strategy: "structural_repair",
          error: "Stage Timeout",
          action: "Generated partial AppSpec from available sections and schema fallbacks",
          outcome: "partial",
          details: { elapsed_ms: elapsed, timeout_type: timeoutType },
        });
      }

      // Record error and emit failed event
      await jobStore.setJobError(jobId, errorMsg);
      await jobStore.addEvent(jobId, {
        type: "stage_failed",
        stage: "spec",
        timestamp: new Date().toISOString(),
        error: errorMsg,
        data: {
          timed_out: timedOut,
          partial_spec_available: timedOut,
          elapsed_ms: elapsed,
        },
      });
      logger.error("Stage failure", error instanceof Error ? error : new Error(errorMsg), {
        jobId,
        stage: "spec",
        timedOut,
      });
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async _executeSpecSection(
    jobId: string, 
    sectionName: string, 
    systemPrompt: string, 
    prompt: string, 
    schemaJson: string,
    abortSignal: AbortSignal
  ): Promise<Record<string, unknown>> { // Changed from any
    try {
      if (abortSignal.aborted) {
        throw new Error(`Spec section ${sectionName} aborted`);
      }

      const response = await this._sendWithRetry(
        jobId,
        "spec",
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: this._trimPromptContext(`Prompt:${prompt}\nSchema:${schemaJson}`) },
        ],
        0.2, // Low temperature for consistency in structured JSON
        500, // Reduced max_tokens per section for faster turnaround
        abortSignal
      );

      const extract = extractJSON<Record<string, unknown>>(response.content);
      if (!extract.success || !extract.data || typeof extract.data !== "object") {
        throw new Error(`Spec ${sectionName} extraction failed: ${extract.error ?? "invalid JSON"}`);
      }

      await jobStore.addValidationSnapshot(jobId, {
        stage: "spec",
        valid: true,
        errors: [],
        timestamp: new Date().toISOString(),
      });

      // Return the extracted data for this section
      return extract.data;
    } catch (error) {
      if (abortSignal.aborted) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Spec section generation degraded", {
        jobId,
        sectionName,
        error: message,
        timedOut: abortSignal.aborted,
      });
      await jobStore.addRepair(jobId, {
        timestamp: new Date().toISOString(),
        stage: "spec",
        strategy: "structural_repair",
        error: `Spec section ${sectionName} failed`,
        action: "Preserved other sections and filled this section from deterministic defaults",
        outcome: "partial",
        details: { error: message },
        timed_out: abortSignal.aborted,
      });
      await jobStore.addEvent(jobId, {
        type: "stage_retry",
        stage: "spec",
        timestamp: new Date().toISOString(),
        data: {
          section: sectionName,
          degraded: true,
        },
        error: message,
        is_degraded: true,
      });
      return {};
    }
  }

  private _buildPartialSpec(
    intent: AppIntent,
    schema: DataSchema,
    sections: Record<string, unknown>
  ): AppSpec {
    const partialSpec: Record<string, unknown> = {
      ...sections,
      data_schema: schema,
    };

    this._ensureMinimumSpec(partialSpec, intent, schema);
    this._coerceSpecCollections(partialSpec, intent, schema);

    const { data: repairedSpec } = repairEngine.repairConsistency(
      "spec",
      partialSpec,
      schema
    );

    this._ensureMinimumSpec(repairedSpec, intent, schema);
    this._coerceSpecCollections(repairedSpec, intent, schema);

    return AppSpecSchema.parse(repairedSpec) as AppSpec;
  }

  private _ensureMinimumSpec( // Explicit return type
    specData: Record<string, unknown>,
    intent: AppIntent,
    schema: DataSchema
  ): void {
    const primaryEntity = schema.entities[0]?.name ?? "Task";
    const requestedIntegrations = intent.integrations_requested.filter((integrationId) =>
      Boolean(getIntegration(integrationId))
    );

    if (!specData.metadata || typeof specData.metadata !== "object") {
      specData.metadata = {
        app_name: intent.appName,
        app_type: intent.appType,
        version: "1.0.0",
        created_at: new Date().toISOString(),
      };
    } else {
        const metadata = specData.metadata as Record<string, unknown>; // Explicit type
      metadata.app_name = typeof metadata.app_name === "string" ? metadata.app_name : intent.appName;
      metadata.app_type = intent.appType;
      metadata.version = typeof metadata.version === "string" ? metadata.version : "1.0.0";
      metadata.created_at =
        typeof metadata.created_at === "string" ? metadata.created_at : new Date().toISOString();
    }

    if (!Array.isArray(specData.pages) || specData.pages.length === 0) {
      specData.pages = [
        {
          name: "dashboard",
          path: "/",
          title: `${intent.appName} Dashboard`,
          requires_auth: true,
          components: ["overview", "task-list"],
        },
        {
          name: primaryEntity.toLowerCase(),
          path: `/${primaryEntity.toLowerCase()}s`,
          title: `${primaryEntity} Management`,
          requires_auth: true,
          components: [`${primaryEntity.toLowerCase()}-list`],
        },
      ];
    }

    if (!Array.isArray(specData.api_endpoints) || specData.api_endpoints.length === 0) {
      specData.api_endpoints = schema.entities.map((entity) => ({
        path: `/api/${entity.tableName}`,
        method: "GET",
        entity: entity.name,
        auth_required: true,
        response_type: "json",
      }));
    }

    for (const key of ["auth_rules", "integration_hooks", "workflows", "assumptions"]) {
      if (!Array.isArray(specData[key])) {
        specData[key] = [];
      }
    }

    specData.integration_hooks = this._ensureIntegrationHooks(
      specData.integration_hooks as Array<Record<string, unknown>>,
      requestedIntegrations,
      schema
    );

    specData.workflows = this._ensureIntegrationWorkflows(
      specData.workflows as Array<Record<string, unknown>>,
      requestedIntegrations,
      schema,
      specData.integration_hooks as Array<Record<string, unknown>>
    );
  }

  private _coerceSpecCollections(
    specData: Record<string, unknown>,
    intent: AppIntent,
    schema: DataSchema
  ): void {
    const primaryEntity = schema.entities[0]?.name ?? "Task";
    const primaryTable = schema.entities[0]?.tableName ?? "tasks";

    const rawPages = Array.isArray(specData.pages) ? specData.pages : [];
    const pages = rawPages
      .filter((page): page is Record<string, unknown> => Boolean(page) && typeof page === "object")
      .map((page, index) => {
        const name = safeSlug(String(page.name ?? page.title ?? (index === 0 ? "dashboard" : primaryEntity)));
        return {
          name,
          path: normalizePath(String(page.path ?? (index === 0 ? "/" : `/${name}`))),
          title: nonEmptyString(page.title, `${titleCase(name)} | ${intent.appName}`),
          description: typeof page.description === "string" ? page.description : undefined,
          requires_auth: typeof page.requires_auth === "boolean" ? page.requires_auth : true,
          components: normalizeStringArray(page.components, [`${name}-view`]),
        };
      });
    specData.pages = pages.length > 0
      ? pages
      : [
          {
            name: "dashboard",
            path: "/",
            title: `${intent.appName} Dashboard`,
            requires_auth: true,
            components: ["dashboard-view"],
          },
        ];

    const entityNames = new Set(schema.entities.map((entity) => entity.name));
    const rawEndpoints = Array.isArray(specData.api_endpoints) ? specData.api_endpoints : [];
    const endpoints = rawEndpoints
      .filter((endpoint): endpoint is Record<string, unknown> => Boolean(endpoint) && typeof endpoint === "object")
      .map((endpoint) => {
        const entity = entityNames.has(String(endpoint.entity)) ? String(endpoint.entity) : primaryEntity;
        const method = normalizeMethod(endpoint.method);
        return {
          path: normalizePath(String(endpoint.path ?? `/api/${primaryTable}`)),
          method,
          entity,
          auth_required: typeof endpoint.auth_required === "boolean" ? endpoint.auth_required : true,
          parameters: isStringRecord(endpoint.parameters) ? endpoint.parameters : undefined,
          response_type: nonEmptyString(endpoint.response_type, "json"),
        };
      });
    specData.api_endpoints = endpoints.length > 0
      ? endpoints
      : schema.entities.map((entity) => ({
          path: `/api/${entity.tableName}`,
          method: "GET" as const,
          entity: entity.name,
          auth_required: true,
          response_type: "json",
        }));

    const rawAuthRules = Array.isArray(specData.auth_rules) ? specData.auth_rules : [];
    specData.auth_rules = rawAuthRules
      .filter((rule): rule is Record<string, unknown> => Boolean(rule) && typeof rule === "object")
      .map((rule) => ({
        resource: nonEmptyString(rule.resource, primaryEntity),
        actions: normalizeStringArray(rule.actions, ["read", "create", "update", "delete"]),
        roles: normalizeStringArray(rule.roles, ["admin", "member"]),
        conditions: rule.conditions && typeof rule.conditions === "object"
          ? (rule.conditions as Record<string, unknown>)
          : undefined,
      }));

    const rawHooks = Array.isArray(specData.integration_hooks) ? specData.integration_hooks : [];
    specData.integration_hooks = rawHooks.filter(
      (hook): hook is Record<string, unknown> => Boolean(hook) && typeof hook === "object"
    );

    const rawWorkflows = Array.isArray(specData.workflows) ? specData.workflows : [];
    specData.workflows = rawWorkflows
      .filter((workflow): workflow is Record<string, unknown> => Boolean(workflow) && typeof workflow === "object")
      .map((workflow) => ({
        name: nonEmptyString(workflow.name, `${primaryEntity} Workflow`),
        trigger_type: normalizeTriggerType(workflow.trigger_type),
        trigger_entity: entityNames.has(String(workflow.trigger_entity)) ? String(workflow.trigger_entity) : primaryEntity,
        steps: normalizeWorkflowSteps(workflow.steps),
      }));

    specData.assumptions = normalizeStringArray(specData.assumptions, []);
  }

  private _normalizeAppType(prompt: string, rawType: string): AppIntent["appType"] { // Explicit return type
    const text = `${prompt} ${rawType}`.toLowerCase();
    if (/\b(crm|deal|deals|lead|leads|pipeline|customer|sales)\b/.test(text)) return "crm";
    if (/\b(task|tasks|project|projects|sprint|engineering team|kanban)\b/.test(text)) return "project_management";
    if (/\b(ecommerce|commerce|store|shop|cart|checkout|order|orders|product catalog)\b/.test(text)) return "ecommerce";
    if (/\b(hr|recruit|candidate|employee|people ops|payroll|onboarding)\b/.test(text)) return "hr_tool";
    if (/\b(inventory|warehouse|stock|sku|shipment|supply)\b/.test(text)) return "inventory";
    if (/\b(analytics|dashboard|reporting|metrics|bi|insights)\b/.test(text)) return "analytics";
    return "custom";
  }

  private _selectWorkflowEntity(schema: DataSchema, integrationId: string): string { // Explicit return type
    const entityNames = schema.entities.map((entity) => entity.name);
    const preferredByIntegration: Record<string, string[]> = {
      whatsapp: ["Deal", "Lead", "Customer", "Task", "Order"],
      slack: ["Task", "Project", "Issue", "Deal", "Lead"],
      gmail: ["Lead", "Customer", "Deal", "User"],
      stripe: ["Order", "Payment", "Invoice", "Customer"],
      webhook: ["Event", "Task", "Deal", "Order"],
    };

    const preferred = preferredByIntegration[integrationId] ?? [];
    return preferred.find((name) => entityNames.includes(name)) ?? entityNames[0] ?? "Entity";
  }

  private _ensureIntegrationHooks( // Explicit return type
    hooks: Array<Record<string, unknown>>,
    requestedIntegrations: string[],
    schema: DataSchema
  ): Array<Record<string, unknown>> {
    const nextHooks = [...hooks];

    for (const integrationId of requestedIntegrations) {
      const integration = getIntegration(integrationId);
      if (!integration) continue;

      const hasHook = nextHooks.some((hook) => hook.integration_id === integrationId);
      if (hasHook) continue;

      const trigger = integration.triggers[0]?.id;
      const action =
        integration.actions.find((candidate) => candidate.id.includes("send"))?.id ??
        integration.actions[0]?.id;
      if (!trigger || !action) continue;

      const entity = this._selectWorkflowEntity(schema, integrationId);
      nextHooks.push({
        integration_id: integrationId,
        trigger,
        action: action, // Ensure action is string
        entity_mapping: {
          entity,
        },
      });
    }

    return nextHooks.filter((hook) => {
      const integrationId = String(hook.integration_id ?? "");
      const trigger = String(hook.trigger ?? "");
      const action = String(hook.action ?? "");
      return (
        Boolean(getIntegration(integrationId)) &&
        validateIntegrationTrigger(integrationId, trigger) &&
        validateIntegrationAction(integrationId, action)
      );
    });
  }

  private _ensureIntegrationWorkflows( // Explicit return type
    workflows: Array<Record<string, unknown>>,
    requestedIntegrations: string[],
    schema: DataSchema,
    hooks: Array<Record<string, unknown>>
  ): Array<Record<string, unknown>> {
    const nextWorkflows = [...workflows];

    for (const integrationId of requestedIntegrations) {
      const hook = hooks.find((candidate) => candidate.integration_id === integrationId);
      if (!hook) continue;
      
      const entity = this._selectWorkflowEntity(schema, integrationId);
      const relatedWorkflow = nextWorkflows.find((workflow) => {
        const name = String(workflow.name ?? "").toLowerCase();
        const triggerEntity = String(workflow.trigger_entity ?? "");
        return (
          triggerEntity === entity ||
          name.includes(entity.toLowerCase()) ||
          name.includes("notification") ||
          name.includes("notify")
        );
      });

      if (relatedWorkflow) {
        const steps = Array.isArray(relatedWorkflow.steps)
          ? (relatedWorkflow.steps as Array<Record<string, unknown>>) // Explicit type
          : [];
        const hasIntegrationStep = steps.some((step) => step.integration_id === integrationId);
        if (!hasIntegrationStep) {
          steps.push({
            action: String(hook.action),
            integration_id: integrationId,
            entity_mapping: {
              entity,
            },
          });
          relatedWorkflow.steps = steps;
          relatedWorkflow.trigger_entity = entity;
        }
      }

      const hasWorkflow = nextWorkflows.some((workflow) =>
        Array.isArray(workflow.steps) &&
        (workflow.steps as Array<Record<string, unknown>>).some(
          (step) => step.integration_id === integrationId
        )
      );

      if (hasWorkflow) continue;

      nextWorkflows.push({
        name: `${entity} ${this._titleCase(String(hook.action ?? "notification"))}`,
        trigger_type: "event",
        trigger_entity: entity,
        steps: [
          {
            action: String(hook.action),
            integration_id: integrationId,
            entity_mapping: {
              entity,
            },
          },
        ],
      });
    }

    return nextWorkflows.map((workflow) => {
      const workflowName = String(workflow.name ?? "");
      return {
        ...workflow,
        trigger_entity: this._entityFromText(workflowName, schema) ?? workflow.trigger_entity,
      };
    });
  }

  private _entityFromText(text: string, schema: DataSchema): string | undefined { // Explicit return type
    const normalized = text.toLowerCase();
    return schema.entities.find((entity) => normalized.includes(entity.name.toLowerCase()))?.name;
  }

  private _titleCase(value: string): string { // Explicit return type
    return value
      .replace(/[_-]+/g, " ")
      .replace(/\b\w/g, (char) => char.toUpperCase());
  }

}

function nonEmptyString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalizeStringArray(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const normalized = value
    .map((item) => String(item ?? "").trim())
    .filter((item) => item.length > 0);
  return normalized.length > 0 ? normalized : fallback;
}

function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "/") return "/";
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}

function normalizeMethod(value: unknown): "GET" | "POST" | "PUT" | "DELETE" | "PATCH" {
  const method = String(value ?? "GET").toUpperCase();
  if (method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH") {
    return method;
  }
  return "GET";
}

function normalizeTriggerType(value: unknown): "event" | "schedule" | "manual" {
  if (value === "schedule" || value === "manual") return value;
  return "event";
}

function normalizeWorkflowSteps(value: unknown): Array<{ action: string; integration_id?: string; entity_mapping?: Record<string, string> }> {
  if (!Array.isArray(value)) return [{ action: "notify" }];
  const steps = value
    .filter((step): step is Record<string, unknown> => Boolean(step) && typeof step === "object")
    .map((step) => ({
      action: nonEmptyString(step.action, "notify"),
      integration_id: typeof step.integration_id === "string" ? step.integration_id : undefined,
      entity_mapping: isStringRecord(step.entity_mapping) ? step.entity_mapping : undefined,
    }));
  return steps.length > 0 ? steps : [{ action: "notify" }];
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(value) &&
    typeof value === "object" &&
    Object.values(value as Record<string, unknown>).every((entry) => typeof entry === "string");
}

function safeSlug(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  return slug || "page";
}

function titleCase(value: string): string {
  return value
    .replace(/[-_]+/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

export function repairIntentData(
  intent: Record<string, unknown>,
  prompt: string
): { data: Record<string, unknown>; logs: import("../types").RepairLog[] } {
  const repaired = { ...intent };
  const logs: import("../types").RepairLog[] = [];
  const promptText = prompt.toLowerCase();

  const inferredFeatures = normalizeStringArray(repaired.features, []);
  const inferredEntities = normalizeStringArray(repaired.entities, []);

  if (inferredFeatures.length === 0) {
    const features = inferIntentFeatures(promptText);
    repaired.features = features.length > 0 ? features : ["Basic CRUD"];
    logs.push(createIntentRepairLog(
      "Empty intent features",
      features.length > 0
        ? `Inferred features from prompt: ${features.join(", ")}`
        : "Applied validation-safe fallback feature",
      features.length > 0 ? "success" : "partial",
      { inferred_features: repaired.features }
    ));
  } else {
    repaired.features = inferredFeatures;
  }

  if (inferredEntities.length === 0) {
    const entities = inferIntentEntities(promptText);
    repaired.entities = entities.length > 0 ? entities : ["Item"];
    logs.push(createIntentRepairLog(
      "Empty intent entities",
      entities.length > 0
        ? `Inferred entities from prompt: ${entities.join(", ")}`
        : "Applied validation-safe fallback entity",
      entities.length > 0 ? "success" : "partial",
      { inferred_entities: repaired.entities }
    ));
  } else {
    repaired.entities = inferredEntities;
  }

  if (!Array.isArray(repaired.integrations_requested)) {
    repaired.integrations_requested = [];
  }
  if (!Array.isArray(repaired.assumptions)) {
    repaired.assumptions = [];
  }

  return { data: repaired, logs };
}

function inferIntentEntities(promptText: string): string[] {
  const entities = new Set<string>();

  if (/\b(todo|todos|task|tasks)\b/.test(promptText)) entities.add("Todo");
  if (/\b(note|notes|memo|memos)\b/.test(promptText)) entities.add("Note");
  if (/\b(auth|login|signup|sign up|user|users|account|accounts)\b/.test(promptText)) entities.add("User");
  if (/\b(ecommerce|commerce|shop|store|product|products|order|orders|cart|checkout)\b/.test(promptText)) {
    entities.add("Product");
    entities.add("Order");
  }
  if (/\b(chat|message|messages|conversation|conversations)\b/.test(promptText)) {
    entities.add("Message");
    entities.add("User");
  }

  return Array.from(entities);
}

function inferIntentFeatures(promptText: string): string[] {
  if (/\b(todo|todos|task|tasks)\b/.test(promptText)) {
    return ["Create todos", "Update todos", "Delete todos"];
  }
  if (/\b(note|notes|memo|memos)\b/.test(promptText)) {
    return ["Create notes", "Update notes", "Delete notes"];
  }
  if (/\b(ecommerce|commerce|shop|store|product|products|order|orders|cart|checkout)\b/.test(promptText)) {
    return ["Browse products", "Manage orders", "Checkout"];
  }
  if (/\b(chat|message|messages|conversation|conversations)\b/.test(promptText)) {
    return ["Send messages", "View conversations", "Manage users"];
  }
  if (/\b(auth|login|signup|sign up|user|users|account|accounts)\b/.test(promptText)) {
    return ["User registration", "User login", "Manage user profiles"];
  }

  return [];
}

function createIntentRepairLog(
  error: string,
  action: string,
  outcome: "success" | "partial",
  details: Record<string, unknown>
): import("../types").RepairLog {
  return {
    timestamp: new Date().toISOString(),
    stage: "intent",
    strategy: "field_repair",
    error,
    action,
    outcome,
    details,
  };
}
