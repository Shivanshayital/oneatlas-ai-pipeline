import { RepairLog, RepairStrategy, DataSchema } from "../types";
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
      const entities = repairedData.entities as Array<Record<string, unknown>>;
      for (const entity of entities) {
        if (!Array.isArray(entity.fields)) {
          entity.fields = [];
        }

        const fields = entity.fields as Array<Record<string, unknown>>;
        if (!fields.some((field) => field && typeof field === "object" && (field as Record<string, unknown>).name === "id")) {
          fields.unshift({ name: "id", type: "uuid", required: true });
          this._logRepair(
            stage,
            strategy,
            `Missing id field for entity ${entity.name ?? "unknown"}`,
            "Injected id primary key field",
            "success"
          );
        }

        if (!fields.some((field) => field && typeof field === "object" && (field as Record<string, unknown>).name === "tenantId")) {
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
            const fieldRecord = field as Record<string, unknown>;
            if (fieldRecord.required === undefined) {
              fieldRecord.required = true;
              this._logRepair(
                stage,
                strategy,
                `Missing required flag for field ${fieldRecord.name ?? "unknown"}`,
                "Defaulted required to true",
                "success"
              );
            }
          }
        }
      }
    }

    if (stage === "spec") {
      if (Array.isArray(repairedData.pages)) {
        const pages = repairedData.pages as Array<Record<string, unknown>>;
        for (const page of pages) {
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
        const endpoints = repairedData.api_endpoints as Array<Record<string, unknown>>;
        for (const endpoint of endpoints) {
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
        }
      }

      if (Array.isArray(repairedData.integration_hooks)) {
        const hooks = repairedData.integration_hooks as Array<Record<string, unknown>>;
        for (const hook of hooks) {
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

    if (Array.isArray(repairedData.workflows)) {
      const workflows = repairedData.workflows as Array<Record<string, unknown>>;
      for (let i = workflows.length - 1; i >= 0; i -= 1) {
        const workflow = workflows[i];
        const triggerEntity = String(workflow.trigger_entity ?? "");

        if (!entities.includes(triggerEntity)) {
          if (entities.length > 0) {
            workflow.trigger_entity = entities[0];
            this._logRepair(
              stage,
              strategy,
              `Broken workflow entity mapping for workflow ${workflow.name ?? i}`,
              `Mapped trigger_entity to ${entities[0]}`,
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
          for (const step of workflow.steps) {
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
          }
        }
      }
    }

    if (Array.isArray(repairedData.integration_hooks)) {
      const hooks = repairedData.integration_hooks as Array<Record<string, unknown>>;
      for (let i = hooks.length - 1; i >= 0; i -= 1) {
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
      const pages = repairedData.pages as Array<Record<string, unknown>>;
      const endpoints = repairedData.api_endpoints as Array<Record<string, unknown>>;

      for (const page of pages) {
        let pathValue = String(page.path ?? "");
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
          const endpointPath = String(endpoint.path ?? "");
          return endpointPath.startsWith(pagePath) || pagePath.startsWith(endpointPath);
        });

        if (!mapped) {
          const placeholderEntity = entities[0] ?? "UnknownEntity";
          const placeholderEndpoint = {
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
    const lastClose = Math.max(lastCurly, lastBracket);
    if (lastClose === -1) {
      return text;
    }
    return text.slice(0, lastClose + 1);
  }

  private _logRepair(
    stage: string,
    strategy: RepairStrategy,
    error: string,
    action: string,
    outcome: "success" | "partial" | "failed"
  ): void {
    this.repairLogs.push({
      timestamp: new Date().toISOString(),
      stage: stage as any,
      strategy,
      error,
      action,
      outcome,
    });
  }

  private _getFieldDefault(field: string): unknown {
    const defaults: Record<string, unknown> = {
      appName: "Generated App",
      appType: "web",
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
