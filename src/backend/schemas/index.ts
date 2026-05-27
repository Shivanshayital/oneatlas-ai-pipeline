import { z } from "zod";

// ============================================================================
// Zod Schemas for Validation
// ============================================================================

// Intent Extraction Schemas
export const DataFieldSchema = z.object({
  name: z.string().min(1).max(100),
  type: z.enum([
    "string",
    "number",
    "boolean",
    "date",
    "timestamp",
    "uuid",
    "json",
    "enum",
  ]),
  required: z.boolean(),
  enum_values: z.array(z.string()).optional(),
  description: z.string().optional(),
});

export const DataRelationSchema = z.object({
  name: z.string().min(1).max(100),
  from_entity: z.string().min(1),
  to_entity: z.string().min(1),
  cardinality: z.enum(["one-to-one", "one-to-many", "many-to-many"]),
  foreign_key_field: z.string().min(1),
  cascade_delete: z.boolean().optional(),
});

export const DataEntitySchema = z.object({
  name: z.string().min(1).max(100),
  tableName: z.string().min(1).max(100),
  fields: z
    .array(DataFieldSchema)
    .min(2)
    .refine(
      (fields) => fields.some((f) => f.name === "tenantId"),
      "Every entity must have a tenantId field"
    ),
  relations: z.array(DataRelationSchema).optional().default([]),
  description: z.string().optional(),
});

export const DataSchemaSchema = z.object({
  schema_version: z.string(),
  entities: z.array(DataEntitySchema).min(1),
  description: z.string().optional(),
});

export const AppIntentSchema = z.object({
  appName: z.string().min(1).max(200),
  appType: z.enum(["web", "mobile", "desktop", "api", "hybrid"]),
  features: z.array(z.string().min(1)).min(1),
  entities: z.array(z.string().min(1)).min(1),
  integrations_requested: z.array(z.string()).default([]),
  assumptions: z.array(z.string()).default([]),
  clarification_required: z.boolean().optional().default(false),
  clarification_question: z.string().optional(),
});

// AppSpec Schemas
export const AuthRuleSchema = z.object({
  resource: z.string().min(1),
  actions: z.array(z.string().min(1)).min(1),
  roles: z.array(z.string().min(1)).min(1),
  conditions: z.record(z.unknown()).optional(),
});

export const ApiEndpointSchema = z.object({
  path: z.string().min(1).regex(/^\//, "Path must start with /"),
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  entity: z.string().min(1),
  auth_required: z.boolean(),
  parameters: z.record(z.string()).optional(),
  response_type: z.string().min(1),
});

export const PageSchema = z.object({
  name: z.string().min(1).max(100),
  path: z.string().min(1).regex(/^\//, "Path must start with /"),
  title: z.string().min(1).max(200),
  description: z.string().optional(),
  requires_auth: z.boolean(),
  components: z.array(z.string().min(1)).min(1),
});

export const IntegrationHookSchema = z.object({
  integration_id: z.string().min(1),
  trigger: z.string().min(1),
  action: z.string().min(1),
  entity_mapping: z.record(z.string()),
});

export const WorkflowStubSchema = z.object({
  name: z.string().min(1).max(100),
  trigger_type: z.enum(["event", "schedule", "manual"]),
  trigger_entity: z.string().min(1),
  steps: z
    .array(
      z.object({
        action: z.string().min(1),
        integration_id: z.string().optional(),
        entity_mapping: z.record(z.string()).optional(),
      })
    )
    .min(1),
});

export const AppSpecSchema = z.object({
  metadata: z.object({
    app_name: z.string().min(1),
    app_type: z.string().min(1),
    version: z.string().min(1),
    created_at: z.string().datetime(),
  }),
  data_schema: DataSchemaSchema,
  pages: z.array(PageSchema).min(1),
  api_endpoints: z
    .array(ApiEndpointSchema)
    .min(1)
    .refine(
      () => true,
      "API endpoints must be consistent with pages"
    ),
  auth_rules: z.array(AuthRuleSchema),
  integration_hooks: z.array(IntegrationHookSchema).default([]),
  workflows: z.array(WorkflowStubSchema).default([]),
  assumptions: z.array(z.string()).default([]),
});

// Job Schemas
export const PipelineJobSchema = z.object({
  id: z.string().uuid(),
  prompt: z.string().min(10).max(5000),
  status: z.enum(["pending", "processing", "completed", "failed"]),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
  result: z
    .object({
      intent: AppIntentSchema,
      schema: DataSchemaSchema,
      spec: AppSpecSchema,
      repairs_applied: z.array(z.object({}).passthrough()),
    })
    .optional(),
  error: z.string().optional(),
});

// Integration Registry Schemas
export const IntegrationActionSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  parameters: z.record(z.string()),
});

export const IntegrationTriggerSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  description: z.string().min(1),
  payload_schema: z.record(z.unknown()),
});

export const IntegrationSchema = z.object({
  id: z.string().min(1),
  displayName: z.string().min(1).max(100),
  authType: z.enum(["oauth2", "api_key", "webhook_signature", "basic"]),
  triggers: z.array(IntegrationTriggerSchema),
  actions: z.array(IntegrationActionSchema),
  icon: z.string().optional(),
  documentationUrl: z.string().url().optional(),
});

// Export type inferences
export type AppIntent = z.infer<typeof AppIntentSchema>;
export type DataSchema = z.infer<typeof DataSchemaSchema>;
export type AppSpec = z.infer<typeof AppSpecSchema>;
export type PipelineJob = z.infer<typeof PipelineJobSchema>;
export type Integration = z.infer<typeof IntegrationSchema>;
