import { z, ZodError } from "zod";
import { ValidationResult, ValidationError } from "../types";
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
  return error.errors.map((err) => ({
    field: err.path.join("."),
    message: err.message,
    code: err.code,
  }));
}

export class ValidationEngine {
  validateAppIntent(data: unknown): ValidationResult {
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

  validateDataSchema(data: unknown): ValidationResult {
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

  validateAppSpec(data: unknown): ValidationResult {
    const baseResult = this._validateAppSpecBase(data);
    if (!baseResult.valid) return baseResult;

    // Additional semantic validations
    const semanticErrors = this._validateAppSpecSemantics(data as Record<string, unknown>);

    return {
      valid: semanticErrors.length === 0,
      errors: semanticErrors,
    };
  }

  private _validateAppSpecBase(data: unknown): ValidationResult {
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

  private _validateAppSpecSemantics(spec: Record<string, unknown>): ValidationError[] {
    const errors: ValidationError[] = [];
    const appSpec = spec as {
      data_schema?: { entities?: Array<{ name: string }> };
      pages?: Array<{ name: string }>;
      api_endpoints?: Array<{ entity?: string }>;
      workflows?: Array<{ trigger_entity?: string }>;
      integration_hooks?: Array<{ integration_id?: string }>;
    };

    if (!appSpec || typeof appSpec !== "object") return errors;

    // Validate entities exist
    const entityNames = new Set(
      appSpec.data_schema?.entities?.map((e) => e.name) ?? []
    );

    if (appSpec.api_endpoints) {
      for (const endpoint of appSpec.api_endpoints) {
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
      for (const workflow of appSpec.workflows) {
        if (workflow.trigger_entity && !entityNames.has(workflow.trigger_entity)) {
          errors.push({
            field: `workflows.${workflow.trigger_entity}`,
            message: `Entity "${workflow.trigger_entity}" not found in data_schema`,
            code: "invalid_entity_reference",
          });
        }
      }
    }

    // Validate integrations exist
    if (appSpec.integration_hooks) {
      const { validateIntegrationReference } = require("./registry");
      for (const hook of appSpec.integration_hooks) {
        if (hook.integration_id && !validateIntegrationReference(hook.integration_id)) {
          errors.push({
            field: `integration_hooks.${hook.integration_id}`,
            message: `Integration "${hook.integration_id}" not found in registry`,
            code: "invalid_integration_reference",
          });
        }
      }
    }

    return errors;
  }

  validateDataEntity(data: unknown): ValidationResult {
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
