import { RepairLog, RepairStrategy, AppIntent, DataSchema, AppSpec } from "../types";
import { ValidationError } from "../types";
import { validateIntegrationReference } from "../integrations/registry";

// ============================================================================
// Repair Engine
// ============================================================================

export class RepairEngine {
  private repairLogs: RepairLog[] = [];

  /**
   * Repair malformed JSON, truncated output, missing braces
   */
  repairStructure(stage: string, rawText: string): { content: string; logs: RepairLog[] } {
    this.repairLogs = [];
    let content = rawText;
    let strategy: RepairStrategy = "structural_repair";
    let attemptCount = 0;

    // Try to close truncated JSON
    if (!content.trim().endsWith("}") && !content.trim().endsWith("]")) {
      const openBraces = (content.match(/{/g) || []).length;
      const closeBraces = (content.match(/}/g) || []).length;
      const openBrackets = (content.match(/\[/g) || []).length;
      const closeBrackets = (content.match(/]/g) || []).length;

      const missingBraces = openBraces - closeBraces;
      const missingBrackets = openBrackets - closeBrackets;

      content += "}".repeat(missingBraces) + "]".repeat(missingBrackets);

      this._logRepair(stage, strategy, "Truncated JSON", "Added missing braces", "success");
      attemptCount++;
    }

    // Remove markdown code fence if present
    if (content.includes("```json") || content.includes("```")) {
      content = content.replace(/```json\n?/g, "").replace(/```\n?/g, "");
      this._logRepair(stage, strategy, "Markdown fence", "Removed fence markers", "success");
      attemptCount++;
    }

    // Remove leading/trailing whitespace
    content = content.trim();

    // Attempt to extract JSON object/array if wrapped in text
    if (!content.startsWith("{") && !content.startsWith("[")) {
      const jsonMatch = content.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
      if (jsonMatch) {
        content = jsonMatch[1];
        this._logRepair(stage, strategy, "Extracted JSON", "Removed text wrapper", "success");
        attemptCount++;
      }
    }

    return {
      content,
      logs: this.repairLogs,
    };
  }

  /**
   * Repair missing fields, wrong types, inject defaults
   */
  repairFields(stage: string, data: Record<string, unknown>, requiredFields: string[]): {
    data: Record<string, unknown>;
    logs: RepairLog[];
  } {
    this.repairLogs = [];
    let strategy: RepairStrategy = "field_repair";
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

    // Fix common type issues
    if ("features" in repairedData && !Array.isArray(repairedData.features)) {
      repairedData.features = [String(repairedData.features)];
      this._logRepair(stage, strategy, "Wrong type: features", "Converted to array", "success");
    }

    if ("entities" in repairedData && !Array.isArray(repairedData.entities)) {
      repairedData.entities = [String(repairedData.entities)];
      this._logRepair(stage, strategy, "Wrong type: entities", "Converted to array", "success");
    }

    return {
      data: repairedData,
      logs: this.repairLogs,
    };
  }

  /**
   * Repair broken references, missing entities, invalid integrations
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
    let strategy: RepairStrategy = "consistency_repair";
    const repairedData = { ...data };

    // Validate entity references in workflows
    const entities = schema?.entities.map((e) => e.name) ?? [];

    if ("workflows" in repairedData && Array.isArray(repairedData.workflows)) {
      const workflows = repairedData.workflows as Array<Record<string, unknown>>;
      for (let i = 0; i < workflows.length; i++) {
        const workflow = workflows[i];
        if (workflow.trigger_entity && !entities.includes(String(workflow.trigger_entity))) {
          if (entities.length > 0) {
            workflow.trigger_entity = entities[0];
            this._logRepair(
              stage,
              strategy,
              `Invalid entity reference in workflow[${i}]`,
              `Mapped to first available entity: ${entities[0]}`,
              "partial"
            );
          }
        }
      }
    }

    // Validate integration references
    if ("integration_hooks" in repairedData && Array.isArray(repairedData.integration_hooks)) {
      const hooks = repairedData.integration_hooks as Array<Record<string, unknown>>;
      for (let i = 0; i < hooks.length; i++) {
        const hook = hooks[i];
        if (hook.integration_id && !validateIntegrationReference(String(hook.integration_id))) {
          this._logRepair(
            stage,
            strategy,
            `Invalid integration: ${hook.integration_id}`,
            "Removed invalid integration hook",
            "partial"
          );
          hooks.splice(i, 1);
          i--;
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
