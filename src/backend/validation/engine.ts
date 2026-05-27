import { ZodError } from "zod";
import { ValidationResult, ValidationError } from "../types";
import {
  validateIntegrationAction,
  validateIntegrationReference,
  validateIntegrationTrigger,
} from "../integrations/registry";
import {
  AppIntentSchema,
  DataSchemaSchema,
  AppSpecSchema,
  DataEntitySchema,
} from "../schemas";

// ============================================================================
// Validation Engine
// ============================================================================

function zodErrorToValidationError(error: ZodError): ValidationError[] {
  return error.errors.map((err: ZodError['errors'][number]) => ({ // Explicit type for err
    field: err.path.join("."),
    message: err.message,
    code: err.code,
  }));
}

export class ValidationEngine {
  validateAppIntent(data: unknown): ValidationResult { // Explicit return type
    try {
      AppIntentSchema.parse(data);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          valid: false,
          errors: zodErrorToValidationError(error),
        };
      }
      return {
        valid: false,
        errors: [
          {
            field: "unknown",
            message: String(error),
            code: "unknown_error",
          },
        ],
      };
    }
  }

  validateDataSchema(data: unknown): ValidationResult { // Explicit return type
    try {
      DataSchemaSchema.parse(data);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          valid: false,
          errors: zodErrorToValidationError(error),
        };
      }
      return {
        valid: false,
        errors: [
          {
            field: "unknown",
            message: String(error),
            code: "unknown_error",
          },
        ],
      };
    }
  }

  validateAppSpec(data: unknown): ValidationResult { // Explicit return type
    const baseResult = this._validateAppSpecBase(data);
    if (!baseResult.valid) return baseResult;

    // Additional semantic validations
    const semanticErrors = this._validateAppSpecSemantics(data as Record<string, unknown>);

    return {
      valid: semanticErrors.length === 0,
      errors: semanticErrors,
    };
  }

  private _validateAppSpecBase(data: unknown): ValidationResult { // Explicit return type
    try {
      AppSpecSchema.parse(data);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          valid: false,
          errors: zodErrorToValidationError(error),
        };
      }
      return {
        valid: false,
        errors: [
          {
            field: "unknown",
            message: String(error),
            code: "unknown_error",
          },
        ],
      };
    }
  }

  private _validateAppSpecSemantics(spec: Record<string, unknown>): ValidationError[] { // Explicit return type
    const errors: ValidationError[] = [];
    const appSpec = spec as {
      data_schema?: { entities?: Array<{ name: string }> };
      pages?: Array<{ name: string; path?: string }>;
      api_endpoints?: Array<{ entity?: string; path?: string; method?: string }>;
      workflows?: Array<{
        name?: string;
        trigger_entity?: string;
        steps?: Array<{ integration_id?: string; action?: string }>;
      }>;
      integration_hooks?: Array<{ integration_id?: string; trigger?: string; action?: string }>;
    };

    if (!appSpec || typeof appSpec !== "object") return errors;

    // Validate entities exist
    const entityNames = new Set(
      appSpec.data_schema?.entities?.map((e) => e.name) ?? []
    );

    if (appSpec.api_endpoints) {
      for (const endpoint of appSpec.api_endpoints) { // Explicit type for endpoint
        if (endpoint.entity && !entityNames.has(endpoint.entity)) {
          errors.push({
            field: `api_endpoints.${endpoint.entity}`,
            message: `Entity "${endpoint.entity}" not found in data_schema`,
            code: "invalid_entity_reference",
          });
        }
      }
    }

    if (appSpec.workflows) {
      for (const workflow of appSpec.workflows) { // Explicit type for workflow
        if (workflow.trigger_entity && !entityNames.has(workflow.trigger_entity)) {
          errors.push({
            field: `workflows.${workflow.trigger_entity}`,
            message: `Entity "${workflow.trigger_entity}" not found in data_schema`,
            code: "invalid_entity_reference",
          });
        }

        const inferredEntity = this._inferEntityFromText(workflow.name ?? "", entityNames);
        if (
          inferredEntity &&
          workflow.trigger_entity &&
          workflow.trigger_entity !== inferredEntity
        ) {
          errors.push({
            field: `workflows.${workflow.name}`,
            message: `Workflow "${workflow.name}" appears to target "${inferredEntity}" but is mapped to "${workflow.trigger_entity}"`,
            code: "workflow_entity_mismatch",
          });
        }

        for (const step of workflow.steps ?? []) { // Explicit type for step
          if (!step.integration_id) continue;
          if (!validateIntegrationReference(step.integration_id)) {
            errors.push({
              field: `workflows.${workflow.name}.steps`,
              message: `Integration "${step.integration_id}" not found in registry`,
              code: "invalid_integration_reference",
            });
            continue;
          }

          if (step.action && !validateIntegrationAction(step.integration_id, step.action)) {
            errors.push({
              field: `workflows.${workflow.name}.steps`,
              message: `Action "${step.action}" is not valid for integration "${step.integration_id}"`,
              code: "invalid_integration_action",
            });
          }

          const matchingHook = appSpec.integration_hooks?.some(
            (hook) => hook.integration_id === step.integration_id
          );
          if (!matchingHook) {
            errors.push({
              field: `integration_hooks.${step.integration_id}`,
              message: `Workflow uses "${step.integration_id}" but no matching integration hook exists`,
              code: "missing_integration_hook",
            });
          }
        }
      }
    }

    // Validate integrations exist
    if (appSpec.integration_hooks) {
      for (const hook of appSpec.integration_hooks) { // Explicit type for hook
        if (hook.integration_id && !validateIntegrationReference(hook.integration_id)) {
          errors.push({
            field: `integration_hooks.${hook.integration_id}`,
            message: `Integration "${hook.integration_id}" not found in registry`,
            code: "invalid_integration_reference",
          });
        }

        if (
          hook.integration_id &&
          hook.trigger &&
          !validateIntegrationTrigger(hook.integration_id, hook.trigger)
        ) {
          errors.push({
            field: `integration_hooks.${hook.integration_id}.trigger`,
            message: `Trigger "${hook.trigger}" is not valid for integration "${hook.integration_id}"`,
            code: "invalid_integration_trigger",
          });
        }

        if (
          hook.integration_id &&
          hook.action &&
          !validateIntegrationAction(hook.integration_id, hook.action)
        ) {
          errors.push({
            field: `integration_hooks.${hook.integration_id}.action`,
            message: `Action "${hook.action}" is not valid for integration "${hook.integration_id}"`,
            code: "invalid_integration_action",
          });
        }
      }
    }

    if (appSpec.pages && appSpec.api_endpoints) {
      for (const page of appSpec.pages) {
        const pagePath = page.path ?? ""; // Explicit type for pagePath
        const hasMappedEndpoint = appSpec.api_endpoints.some((endpoint) => {
          const endpointPath = endpoint.path ?? "";
          return endpointPath === pagePath || endpointPath.startsWith(`/api${pagePath}`);
        });

        if (pagePath && !hasMappedEndpoint) {
          errors.push({
            field: `pages.${page.name}`,
            message: `Page "${page.name}" has no matching API endpoint`,
            code: "missing_page_api_mapping",
          });
        }
      }
    }

    return errors;
  }

  private _inferEntityFromText(text: string, entities: Set<string>): string | undefined { // Explicit return type
    const normalized = text.toLowerCase();
    return Array.from(entities).find((entity) => normalized.includes(entity.toLowerCase()));
  }

  validateDataEntity(data: unknown): ValidationResult { // Explicit return type
    try {
      DataEntitySchema.parse(data);
      return { valid: true, errors: [] };
    } catch (error) {
      if (error instanceof ZodError) {
        return {
          valid: false,
          errors: zodErrorToValidationError(error),
        };
      }
      return {
        valid: false,
        errors: [
          {
            field: "unknown",
            message: String(error),
            code: "unknown_error",
          },
        ],
      };
    }
  }
}

export const validationEngine = new ValidationEngine();

export function createValidationEngine(): ValidationEngine {
  return new ValidationEngine();
}
