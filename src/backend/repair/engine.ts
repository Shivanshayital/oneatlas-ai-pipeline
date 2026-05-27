import {
  ApiEndpoint,
  AuthRule,
  DataEntity,
  DataField,
  DataRelation,
  DataSchema,
  IntegrationHook,
  Page,
  PipelineStage,
  RepairLog,
  RepairStrategy,
  WorkflowStub,
} from "../types";
import {
  autoCloseJsonStructures,
  extractJsonBlock,
  sanitizeJsonString,
  safeParseJson,
} from "../utils/json-parser";
import {
  getIntegration,
  validateIntegrationAction,
  validateIntegrationTrigger,
} from "../integrations/registry";

// ============================================================================
// Repair Engine
// ============================================================================

export class RepairEngine {
  private repairLogs: RepairLog[] = [];

  /**
   * Repair malformed JSON, truncated output, missing quotes, or broken arrays.
   */
  repairStructure(stage: string, rawText: string): { content: string; logs: RepairLog[] } {
    this.repairLogs = [];
    const strategy: RepairStrategy = "structural_repair";
    let content = sanitizeJsonString(rawText);

    if (content !== rawText.trim()) {
      this._logRepair(
        stage,
        strategy,
        "Raw text sanitized",
        "Removed markdown wrappers and normalized quotes",
        "success"
      );
    }

    const extracted = extractJsonBlock(content);
    if (extracted && extracted !== content) {
      content = extracted;
      this._logRepair(
        stage,
        strategy,
        "JSON block extracted",
        "Removed explanation text around JSON",
        "success"
      );
    }

    const corrected = autoCloseJsonStructures(content);
    if (corrected !== content) {
      content = corrected;
      this._logRepair(
        stage,
        strategy,
        "JSON auto-closed",
        "Fixed trailing commas, quotes, and unbalanced braces/brackets",
        "success"
      );
    }

    const parseResult = safeParseJson(content);
    if (!parseResult.success) {
      const trimmed = this._trimAfterClosingDelimiter(content);
      if (trimmed !== content) {
        content = trimmed;
        this._logRepair(
          stage,
          strategy,
          "Trimmed trailing garbage",
          "Removed content after last JSON delimiter",
          "success"
        );
      }
    }

    return {
      content,
      logs: this.repairLogs,
    };
  }

  /**
   * Repair missing fields, wrong types, inject defaults, and normalize entity/schema payloads.
   */
  repairFields(stage: string, data: Record<string, unknown>, requiredFields: string[]): {
    data: Record<string, unknown>;
    logs: RepairLog[];
  } {
    this.repairLogs = [];
    const strategy: RepairStrategy = "field_repair";
    const repairedData = { ...data };

    for (const field of requiredFields) {
      if (!(field in repairedData) || repairedData[field] === undefined || repairedData[field] === null) {
        const defaultValue = this._getFieldDefault(field);
        repairedData[field] = defaultValue;

        this._logRepair(
          stage,
          strategy,
          `Missing field: ${field}`,
          `Injected default value: ${JSON.stringify(defaultValue)}`,
          "success"
        );
      }
    }

    if ("features" in repairedData && !Array.isArray(repairedData.features)) {
      repairedData.features = [String(repairedData.features)];
      this._logRepair(stage, strategy, "Wrong type: features", "Converted to array", "success");
    }

    if ("entities" in repairedData && !Array.isArray(repairedData.entities)) {
      repairedData.entities = [String(repairedData.entities)];
      this._logRepair(stage, strategy, "Wrong type: entities", "Converted to array", "success");
    }

    if (stage === "schema" && Array.isArray(repairedData.entities)) {
      const entities = repairedData.entities as DataEntity[]; // Explicit type
      for (const entity of entities) { // Explicit type for entity
        if (!Array.isArray(entity.fields)) {
          entity.fields = [];
        }

        const fields = entity.fields as DataField[]; // Explicit type
        if (!fields.some((field) => field && typeof field === "object" && field.name === "id")) {
          fields.unshift({ name: "id", type: "uuid", required: true });
          this._logRepair(
            stage,
            strategy,
            `Missing id field for entity ${entity.name ?? "unknown"}`,
            "Injected id primary key field",
            "success"
          );
        }

        if (!fields.some((field) => field && typeof field === "object" && field.name === "tenantId")) {
          fields.splice(1, 0, { name: "tenantId", type: "uuid", required: true });
          this._logRepair(
            stage,
            strategy,
            `Missing tenantId field for entity ${entity.name ?? "unknown"}`,
            "Injected tenantId field for multi-tenancy",
            "success"
          );
        }

        for (const field of fields) {
          if (field && typeof field === "object") {
            if (field.required === undefined) {
              field.required = true;
              this._logRepair(
                stage,
                strategy,
                `Missing required flag for field ${field.name ?? "unknown"}`,
                "Defaulted required to true",
                "success"
              );
            }
          }
        }

        if (Array.isArray(entity.relations)) {
          const relations = entity.relations as DataRelation[]; // Explicit type
          for (let index = relations.length - 1; index >= 0; index -= 1) { // Explicit type for index
            const relation = relations[index];
            if (!relation || typeof relation !== "object") {
              relations.splice(index, 1);
              continue;
            }

            const fromEntity = String(relation.from_entity ?? entity.name ?? "");
            const toEntity = String(relation.to_entity ?? "");
            if (!fromEntity || !toEntity) {
              relations.splice(index, 1);
              this._logRepair(
                stage,
                strategy,
                `Invalid relation on entity ${entity.name ?? "unknown"}`,
                "Removed relation without from_entity/to_entity",
                "partial"
              );
              continue;
            }

            relation.from_entity = fromEntity;
            relation.to_entity = toEntity;

            if (!relation.name) {
              relation.name = `${fromEntity}_${toEntity}_relation`;
              this._logRepair(
                stage,
                strategy,
                `Missing relation name for ${fromEntity} -> ${toEntity}`,
                `Injected relation name ${relation.name}`,
                "success"
              );
            }

            if (typeof relation.cardinality === "string") {
              const cardinality = relation.cardinality.replace(/_/g, "-");
              relation.cardinality = ["one-to-one", "one-to-many", "many-to-many"].includes(cardinality)
                ? (cardinality as DataRelation["cardinality"])
                : "one-to-many";
            }

            if (!["one-to-one", "one-to-many", "many-to-many"].includes(String(relation.cardinality))) {
              relation.cardinality = "one-to-many";
              this._logRepair(
                stage,
                strategy,
                `Invalid relation cardinality for ${relation.name}`,
                "Mapped cardinality to one-to-many",
                "partial"
              );
            }

            if (!relation.foreign_key_field) {
              relation.foreign_key_field = `${String(toEntity).charAt(0).toLowerCase()}${String(toEntity).slice(1)}Id`;
              this._logRepair(
                stage,
                strategy,
                `Missing foreign_key_field for ${relation.name}`,
                `Injected foreign key ${relation.foreign_key_field}`,
                "success"
              );
            }
          }
        } else {
          entity.relations = [];
        }
      }
    }

    if (stage === "spec") {
      for (const key of ["pages", "api_endpoints", "auth_rules", "integration_hooks", "workflows", "assumptions"]) {
        if (key in repairedData && !Array.isArray(repairedData[key])) {
          repairedData[key] = [];
          this._logRepair(stage, strategy, `Wrong type: ${key}`, "Converted to empty array", "partial");
        }
      }

      if (repairedData.metadata && typeof repairedData.metadata === "object") {
        const metadata = repairedData.metadata as Record<string, unknown>; // Explicit type
        if (!metadata.version) metadata.version = "1.0.0";
        if (!metadata.created_at || typeof metadata.created_at !== "string") {
          metadata.created_at = new Date().toISOString();
          this._logRepair(stage, strategy, "Invalid metadata.created_at", "Injected current ISO timestamp", "success");
        }
      }

      if (Array.isArray(repairedData.pages)) {
        const pages = repairedData.pages as Page[]; // Explicit type
        for (const page of pages) { // Explicit type for page
          if (page.requires_auth === undefined) {
            page.requires_auth = false;
            this._logRepair(
              stage,
              strategy,
              `Missing requires_auth for page ${page.name ?? "unknown"}`,
              "Set requires_auth to false",
              "success"
            );
          }

          if (!Array.isArray(page.components) || page.components.length === 0) {
            page.components = ["default"];
            this._logRepair(
              stage,
              strategy,
              `Missing components for page ${page.name ?? "unknown"}`,
              "Injected default page component",
              "success"
            );
          }
        }
      }

      if (Array.isArray(repairedData.api_endpoints)) {
        const endpoints = repairedData.api_endpoints as ApiEndpoint[]; // Explicit type
        for (const endpoint of endpoints) { // Explicit type for endpoint
          if (endpoint.auth_required === undefined) {
            endpoint.auth_required = false;
            this._logRepair(
              stage,
              strategy,
              `Missing auth_required for endpoint ${endpoint.path ?? "unknown"}`,
              "Set auth_required to false",
              "success"
            );
          }

          if (typeof endpoint.method === "string") {
            const method = endpoint.method.toUpperCase();
            endpoint.method = ["GET", "POST", "PUT", "DELETE", "PATCH"].includes(method)
              ? (method as ApiEndpoint["method"])
              : "GET";
          }
        }
      }

      if (Array.isArray(repairedData.integration_hooks)) {
        const hooks = repairedData.integration_hooks as IntegrationHook[]; // Explicit type
        for (const hook of hooks) { // Explicit type for hook
          if (!hook.entity_mapping || typeof hook.entity_mapping !== "object") {
            hook.entity_mapping = {};
            this._logRepair(
              stage,
              strategy,
              `Missing entity_mapping for integration hook ${hook.integration_id ?? "unknown"}`,
              "Injected empty entity mapping",
              "success"
            );
          }
        }
      }

      if (Array.isArray(repairedData.auth_rules)) {
        const authRules = repairedData.auth_rules as AuthRule[]; // Explicit type
        for (let index = authRules.length - 1; index >= 0; index -= 1) { // Explicit type for index
          const rule = authRules[index];
          if (!rule || typeof rule !== "object") {
            authRules.splice(index, 1);
            continue;
          }

          if (!rule.resource) {
            authRules.splice(index, 1);
            this._logRepair(
              stage,
              strategy,
              "Invalid auth rule",
              "Removed auth rule without resource",
              "partial"
            );
            continue;
          }

          if (!Array.isArray(rule.actions) || rule.actions.length === 0) {
            rule.actions = ["read", "create", "update", "delete"];
            this._logRepair(
              stage,
              strategy,
              `Missing actions for auth rule ${rule.resource}`,
              "Injected CRUD actions",
              "partial"
            );
          }

          if (!Array.isArray(rule.roles) || rule.roles.length === 0) {
            rule.roles = ["admin", "member"];
            this._logRepair(
              stage,
              strategy,
              `Missing roles for auth rule ${rule.resource}`,
              "Injected default roles",
              "partial"
            );
          }
        }
      }

      if (Array.isArray(repairedData.workflows)) {
        const workflows = repairedData.workflows as WorkflowStub[]; // Explicit type
        for (const workflow of workflows) { // Explicit type for workflow
          if (!["event", "schedule", "manual"].includes(String(workflow.trigger_type))) {
            workflow.trigger_type = "event";
            this._logRepair(
              stage,
              strategy,
              `Invalid trigger_type for workflow ${workflow.name ?? "unknown"}`,
              "Mapped trigger_type to event",
              "partial"
            );
          }

          if (!Array.isArray(workflow.steps) || workflow.steps.length === 0) {
            workflow.steps = [{ action: "notify" }];
            this._logRepair(
              stage,
              strategy,
              `Missing steps for workflow ${workflow.name ?? "unknown"}`,
              "Injected placeholder workflow step",
              "partial"
            );
          }
        }
      }

      if (Array.isArray(repairedData.assumptions)) {
        repairedData.assumptions = repairedData.assumptions.map((assumption) => {
          if (typeof assumption === "string") return assumption; // Explicit type for assumption
          if (assumption && typeof assumption === "object") {
            const record = assumption as Record<string, unknown>;
            const firstStringValue = Object.values(record).find(
              (value): value is string => typeof value === "string"
            );
            return firstStringValue ?? JSON.stringify(record);
          }
          return String(assumption);
        });
      }
    }

    return {
      data: repairedData,
      logs: this.repairLogs,
    };
  }

  /**
   * Repair broken references, missing entities, invalid workflow mappings, and page bindings.
   */
  repairConsistency(
    stage: string,
    data: Record<string, unknown>,
    schema: DataSchema | null
  ): {
    data: Record<string, unknown>;
    logs: RepairLog[];
  } {
    this.repairLogs = [];
    const strategy: RepairStrategy = "consistency_repair";
    const repairedData = { ...data };
    const entities = schema?.entities.map((entity) => entity.name) ?? [];

    if (Array.isArray(repairedData.workflows)) { // Type guard
      const workflows = repairedData.workflows as WorkflowStub[]; // Explicit type
      for (let i = workflows.length - 1; i >= 0; i -= 1) {
        const workflow = workflows[i];
        const triggerEntity = String(workflow.trigger_entity ?? "");
        const inferredEntity = this._inferEntityFromText(String(workflow.name ?? ""), entities);

        if (!entities.includes(triggerEntity)) {
          if (inferredEntity || entities.length > 0) {
            workflow.trigger_entity = inferredEntity ?? entities[0];
            this._logRepair(
              stage,
              strategy,
              `Broken workflow entity mapping for workflow ${workflow.name ?? i}`,
              `Mapped trigger_entity to ${workflow.trigger_entity}`,
              "partial"
            );
          } else {
            workflows.splice(i, 1);
            this._logRepair(
              stage,
              strategy,
              `Removed workflow with invalid trigger entity ${triggerEntity}`,
              "Deleted workflow entry",
              "partial"
            );
          }
        }

        if (Array.isArray(workflow.steps)) {
          for (const step of workflow.steps) { // Explicit type for step
            const integrationId = String(step.integration_id ?? "");
            const actionId = String(step.action ?? "");
            const integration = getIntegration(integrationId);

            if (integrationId && !integration) {
              step.integration_id = undefined;
              this._logRepair(
                stage,
                strategy,
                `Invalid integration_id in workflow step: ${integrationId}`,
                "Removed invalid integration reference",
                "partial"
              );
            }

            if (integration && actionId && !validateIntegrationAction(integrationId, actionId)) {
              const fallback = integration.actions[0]?.id;
              if (fallback) {
                step.action = fallback;
                this._logRepair(
                  stage,
                  strategy,
                  `Invalid action ${actionId} for integration ${integrationId}`,
                  `Mapped to first valid action ${fallback}`,
                  "partial"
                );
              }
            }

            if (integration && !actionId) {
              const fallback = integration.actions[0]?.id;
              if (fallback) {
                step.action = fallback;
                this._logRepair(
                  stage,
                  strategy,
                  `Missing action for integration ${integrationId}`,
                  `Mapped to first valid action ${fallback}`,
                  "partial"
                );
              }
            }
          }
        }
      }
    }

    if (Array.isArray(repairedData.integration_hooks)) {
      const hooks = repairedData.integration_hooks as IntegrationHook[]; // Explicit type
      for (let i = hooks.length - 1; i >= 0; i -= 1) { // Explicit type for index
        const hook = hooks[i];
        const integrationId = String(hook.integration_id ?? "");
        const triggerId = String(hook.trigger ?? "");
        const actionId = String(hook.action ?? "");
        const integration = getIntegration(integrationId);

        if (!integration) {
          hooks.splice(i, 1);
          this._logRepair(
            stage,
            strategy,
            `Removed hook with invalid integration id ${integrationId}`,
            "Dropped invalid integration hook",
            "partial"
          );
          continue;
        }

        if (triggerId && !validateIntegrationTrigger(integrationId, triggerId)) {
          const fallbackTrigger = integration.triggers[0]?.id;
          hook.trigger = fallbackTrigger;
          this._logRepair(
            stage,
            strategy,
            `Invalid trigger ${triggerId} for integration ${integrationId}`,
            `Mapped to trigger ${fallbackTrigger}`,
            "partial"
          );
        }

        if (actionId && !validateIntegrationAction(integrationId, actionId)) {
          const fallbackAction = integration.actions[0]?.id;
          hook.action = fallbackAction;
          this._logRepair(
            stage,
            strategy,
            `Invalid action ${actionId} for integration ${integrationId}`,
            `Mapped to action ${fallbackAction}`,
            "partial"
          );
        }
      }
    }

    if (Array.isArray(repairedData.pages) && Array.isArray(repairedData.api_endpoints)) {
      const pages = repairedData.pages as Page[]; // Explicit type
      const endpoints = repairedData.api_endpoints as ApiEndpoint[]; // Explicit type

      for (const page of pages) {
    const pathValue = String(page.path ?? "");
        if (pathValue && !pathValue.startsWith("/")) {
          page.path = `/${pathValue}`;
          this._logRepair(
            stage,
            strategy,
            `Page path missing leading slash for ${page.name ?? "unknown"}`,
            `Updated path to ${page.path}`,
            "success"
          );
        }
      }

      for (const page of pages) {
        const pagePath = String(page.path ?? "");
        const mapped = endpoints.some((endpoint) => {
          const endpointPath = String(endpoint.path ?? ""); // Explicit type for endpointPath
          return endpointPath.startsWith(pagePath) || pagePath.startsWith(endpointPath);
        });

        if (!mapped) {
          const placeholderEntity = entities[0] ?? "UnknownEntity";
          const placeholderEndpoint: ApiEndpoint = {
            path: pagePath || "/",
            method: "GET",
            entity: placeholderEntity,
            auth_required: false,
            response_type: "json",
          };
          endpoints.push(placeholderEndpoint);
          this._logRepair(
            stage,
            strategy,
            `Missing endpoint for page ${page.name ?? "unknown"}`,
            `Created placeholder API endpoint ${placeholderEndpoint.path}`,
            "partial"
          );
        }
      }
    }

    return {
      data: repairedData,
      logs: this.repairLogs,
    };
  }

  /**
   * Get all repair logs for this session
   */
  getLogs(): RepairLog[] {
    return this.repairLogs;
  }

  /**
   * Clear repair logs
   */
  clearLogs(): void {
    this.repairLogs = [];
  }

  // ========== Private Helpers ==========

  private _trimAfterClosingDelimiter(text: string): string {
    const lastCurly = text.lastIndexOf("}");
    const lastBracket = text.lastIndexOf("]");
    const lastClose: number = Math.max(lastCurly, lastBracket); // Explicit type
    if (lastClose === -1) {
      return text;
    }
    return text.slice(0, lastClose + 1);
  }

  private _logRepair(
    stage: string,
    strategy: RepairStrategy,
    error: string,
    action: string, // Explicit type
    outcome: "success" | "partial" | "failed"
  ): void {
    this.repairLogs.push({
      timestamp: new Date().toISOString(),
      stage: this._normalizeStage(stage),
      strategy,
      error,
      action,
      outcome,
    });
  }

  private _inferEntityFromText(text: string, entities: string[]): string | undefined { // Explicit return type
    const normalized = text.toLowerCase();
    return entities.find((entity) => normalized.includes(entity.toLowerCase()));
  }

  private _normalizeStage(stage: string): PipelineStage {
    if (stage === "intent" || stage === "schema" || stage === "spec") {
      return stage;
    }
    return "failed";
  }

  private _getFieldDefault(field: string): unknown {
    const defaults: Record<string, unknown> = {
      appName: "Generated App",
      appType: "custom",
      features: [],
      entities: [],
      integrations_requested: [],
      assumptions: [],
      clarification_required: false,
      schema_version: "1.0.0",
      pages: [],
      api_endpoints: [],
      auth_rules: [],
      integration_hooks: [],
      workflows: [],
      tenantId: "default",
      fields: [],
      relations: [],
    };

    return defaults[field] ?? null;
  }
}

export const repairEngine = new RepairEngine();
