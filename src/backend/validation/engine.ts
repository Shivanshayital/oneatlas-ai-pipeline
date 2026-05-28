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

    // Additional semantic validations. Page/API mapping is intentionally soft:
    // LLMs often emit probabilistic page names such as "taskdetail" while the
    // API uses REST collection/detail paths such as "/api/tasks/:taskId".
    const semanticResult = this._validateAppSpecSemantics(data as Record<string, unknown>);

    return {
      valid: semanticResult.errors.length === 0,
      errors: semanticResult.errors,
      warnings: semanticResult.warnings,
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

  private _validateAppSpecSemantics(
    spec: Record<string, unknown>
  ): { errors: ValidationError[]; warnings: string[] } { // Explicit return type
    const errors: ValidationError[] = [];
    const warnings: string[] = [];
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

    if (!appSpec || typeof appSpec !== "object") return { errors, warnings };

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
        const hasMappedEndpoint = appSpec.api_endpoints.some((endpoint) =>
          hasMatchingPageEndpoint(page, endpoint)
        );

        if (page.path && !hasMappedEndpoint) {
          warnings.push(
            `missing_page_api_mapping: Page "${page.name}" has no matching API endpoint`
          );
        }
      }
    }

    return { errors, warnings };
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

type PageMappingCandidate = {
  name: string;
  path?: string;
};

type EndpointMappingCandidate = {
  entity?: string;
  path?: string;
};

const PAGE_NAME_SUFFIXES = ["details", "detail", "page", "view"];

function hasMatchingPageEndpoint(
  page: PageMappingCandidate,
  endpoint: EndpointMappingCandidate
): boolean {
  const pagePath = normalizeRoutePath(page.path ?? "");
  const endpointPath = normalizeRoutePath(endpoint.path ?? "");

  if (pagePath && endpointPath) {
    const apiPagePath = normalizeRoutePath(`/api${pagePath === "/" ? "" : pagePath}`);
    if (
      endpointPath === pagePath ||
      endpointPath === apiPagePath ||
      endpointPath.startsWith(`${apiPagePath}/`) ||
      routePatternsShareEntity(pagePath, endpointPath)
    ) {
      return true;
    }
  }

  const pageKeys = buildResourceMatchKeys([page.name, page.path ?? ""]);
  const endpointKeys = buildResourceMatchKeys([endpoint.entity ?? "", endpoint.path ?? ""]);

  for (const key of pageKeys) {
    if (endpointKeys.has(key)) return true;
  }

  return false;
}

function routePatternsShareEntity(pagePath: string, endpointPath: string): boolean {
  const pageSegments = routeResourceSegments(pagePath);
  const endpointSegments = routeResourceSegments(endpointPath);
  return pageSegments.some((pageSegment) =>
    endpointSegments.some((endpointSegment) => resourcesEquivalent(pageSegment, endpointSegment))
  );
}

function buildResourceMatchKeys(values: string[]): Set<string> {
  const keys = new Set<string>();

  for (const value of values) {
    for (const token of resourceTokens(value)) {
      const normalized = normalizeResourceName(token);
      if (!normalized) continue;

      // These fallback keys make validation resilient to LLM naming drift:
      // "taskdetail", "task-details", and "Task View" all produce "task",
      // then plural/singular variants are compared against endpoint entities
      // and REST paths such as "/api/tasks/:taskId".
      keys.add(normalized);
      keys.add(singularizeResource(normalized));
      keys.add(pluralizeResource(normalized));
    }
  }

  return keys;
}

function resourceTokens(value: string): string[] {
  const routeSegments = routeResourceSegments(value);
  const words = value
    .split(/[^a-zA-Z0-9]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  return [...routeSegments, ...words, value];
}

function routeResourceSegments(path: string): string[] {
  return normalizeRoutePath(path)
    .split("/")
    .filter((segment) => segment && segment !== "api")
    .map((segment) => segment.replace(/^:/, ""))
    .map(stripIdentifierSuffix)
    .filter((segment) => segment.length > 0);
}

function normalizeResourceName(value: string): string {
  let normalized = stripIdentifierSuffix(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");

  // Detail pages are usually named after an entity plus a UI suffix. Removing
  // these suffixes lets "taskdetail" and "user-view" match entity endpoints.
  let didStrip = true;
  while (didStrip) {
    didStrip = false;
    for (const suffix of PAGE_NAME_SUFFIXES) {
      if (normalized.length > suffix.length && normalized.endsWith(suffix)) {
        normalized = normalized.slice(0, -suffix.length);
        didStrip = true;
      }
    }
  }

  return normalized;
}

function resourcesEquivalent(left: string, right: string): boolean {
  const leftName = normalizeResourceName(left);
  const rightName = normalizeResourceName(right);
  if (!leftName || !rightName) return false;
  return (
    leftName === rightName ||
    singularizeResource(leftName) === singularizeResource(rightName) ||
    pluralizeResource(leftName) === pluralizeResource(rightName)
  );
}

function stripIdentifierSuffix(value: string): string {
  return value.replace(/id$/i, "");
}

function singularizeResource(value: string): string {
  if (value.endsWith("ies") && value.length > 3) return `${value.slice(0, -3)}y`;
  if (value.endsWith("ses") && value.length > 3) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 1) return value.slice(0, -1);
  return value;
}

function pluralizeResource(value: string): string {
  if (value.endsWith("y") && value.length > 1) return `${value.slice(0, -1)}ies`;
  if (value.endsWith("s")) return value;
  return `${value}s`;
}

function normalizeRoutePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const prefixed = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return prefixed.replace(/\/+/g, "/").replace(/\/$/g, "") || "/";
}

export const validationEngine = new ValidationEngine();

export function createValidationEngine(): ValidationEngine {
  return new ValidationEngine();
}
