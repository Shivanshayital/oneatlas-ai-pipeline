// ============================================================================
// Core Type Definitions for AI Pipeline
// ============================================================================

export interface AppIntent {
  appName: string;
  appType:
    | "crm"
    | "project_management"
    | "ecommerce"
    | "hr_tool"
    | "inventory"
    | "analytics"
    | "custom";
  features: string[];
  entities: string[];
  integrations_requested: string[];
  assumptions: string[];
  clarification_required?: boolean;
  clarification_question?: string;
}

export interface DataField {
  name: string;
  type:
    | "string"
    | "number"
    | "boolean"
    | "date"
    | "timestamp"
    | "uuid"
    | "json"
    | "enum";
  required: boolean;
  enum_values?: string[];
  description?: string;
}

export interface DataRelation {
  name: string;
  from_entity: string;
  to_entity: string;
  cardinality: "one-to-one" | "one-to-many" | "many-to-many";
  foreign_key_field: string;
  cascade_delete?: boolean;
}

export interface DataEntity {
  name: string;
  tableName: string;
  fields: DataField[];
  relations: DataRelation[];
  description?: string;
}

export interface DataSchema {
  schema_version: string;
  entities: DataEntity[];
  description?: string;
}

export interface AuthRule {
  resource: string;
  actions: string[];
  roles: string[];
  conditions?: Record<string, unknown>;
}

export interface ApiEndpoint {
  path: string;
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  entity: string;
  auth_required: boolean;
  parameters?: Record<string, string>;
  response_type: string;
}

export interface Page {
  name: string;
  path: string;
  title: string;
  description?: string;
  requires_auth: boolean;
  components: string[];
}

export interface IntegrationHook {
  integration_id: string;
  trigger: string;
  action: string;
  entity_mapping: Record<string, string>;
}

export interface WorkflowStub {
  name: string;
  trigger_type: "event" | "schedule" | "manual";
  trigger_entity: string;
  steps: Array<{
    action: string;
    integration_id?: string;
    entity_mapping?: Record<string, string>;
  }>;
}

export interface AppSpec {
  metadata: {
    app_name: string;
    app_type: string;
    version: string;
    created_at: string;
  };
  data_schema: DataSchema;
  pages: Page[];
  api_endpoints: ApiEndpoint[];
  auth_rules: AuthRule[];
  integration_hooks: IntegrationHook[];
  workflows: WorkflowStub[];
  assumptions: string[];
}

// Job and Progress Tracking
export type PipelineStage = "intent" | "schema" | "spec" | "complete" | "failed";

export interface StageEvent {
  type:
    | "stage_start"
    | "stage_complete"
    | "stage_failed"
    | "stage_retry"
    | "stage_provider_usage"
    | "generation_complete";
  stage: PipelineStage;
  timestamp: string;
  data?: Record<string, unknown>;
  latency_ms?: number;
  provider?: AIProvider;
  model?: string;
  tokens?: TokenMetrics;
  cost_usd?: number;
  error?: string;
}

export interface ProviderUsage {
  stage: PipelineStage;
  provider: AIProvider;
  model: string;
  latency_ms: number;
  tokens: TokenMetrics; // Use the standard TokenMetrics
  cost_usd: number;
  attempt: number;
  timestamp: string;
}

export interface RetryEntry {
  stage: PipelineStage;
  attempt: number;
  provider: AIProvider;
  model: string;
  error: string;
  timestamp: string;
}

export interface ValidationSnapshot {
  stage: PipelineStage;
  valid: boolean;
  errors: ValidationError[];
  timestamp: string;
}

export interface JobResult {
  intent: AppIntent;
  schema: DataSchema;
  spec: AppSpec;
  repairs_applied: RepairLog[];
}

export interface PipelineJob {
  id: string;
  prompt: string;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: string;
  updated_at: string;
  result?: JobResult;
  error?: string;
}

// Validation Results
export interface ValidationError {
  field: string;
  message: string;
  code: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings?: string[];
}

// Repair Logs
export type RepairStrategy =
  | "structural_repair"
  | "field_repair"
  | "consistency_repair"
  | "retry_with_different_model";

export interface RepairLog {
  timestamp: string;
  stage: PipelineStage;
  strategy: RepairStrategy;
  error: string;
  action: string;
  outcome: "success" | "partial" | "failed";
  details?: Record<string, unknown>;
}

// AI Gateway
export type AIProvider = "openai" | "groq" | "gemini" | "anthropic" | "mistral" | "deepseek" | "openrouter";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIRequest {
  provider: AIProvider;
  model: string;
  messages: AIMessage[];
  temperature?: number;
  max_tokens?: number;
  stage?: PipelineStage; // Added for more granular fallback logic in gateway
}

export interface AIResponse {
  content: string;
  model: string;
  provider: AIProvider;
  usage: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
  latency_ms: number;
}

// Integration Registry
export type AuthType = "oauth2" | "api_key" | "webhook_signature" | "basic";

export interface IntegrationAction {
  id: string;
  name: string;
  description: string;
  parameters: Record<string, string>;
}

export interface IntegrationTrigger {
  id: string;
  name: string;
  description: string;
  payload_schema: Record<string, unknown>;
}

export interface Integration {
  id: string;
  displayName: string;
  authType: AuthType;
  triggers: IntegrationTrigger[];
  actions: IntegrationAction[];
  icon?: string;
  documentationUrl?: string;
}

// Token and Cost Tracking
export interface TokenMetrics {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
}

export interface LatencyMetrics {
  intent_stage_ms: number;
  schema_stage_ms: number;
  spec_stage_ms: number;
  total_ms: number;
}

export interface PipelineMetrics {
  tokens: TokenMetrics;
  tokens_normalized?: TokenMetrics;
  latency: LatencyMetrics;
  repair_attempts: number;
  successful_repairs: number;
}

export interface ProviderUsageSummaryItem {
  provider: AIProvider;
  model?: string; // Last used model for this provider
  requests: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  estimatedCost: number;
  latencyMs: number; // Average latency
  status: "active" | "healthy" | "unhealthy" | "cooldown";
  estimatedRemainingQuota: number;
  quotaStatus: 'low' | 'medium' | 'high' | 'near_limit' | 'unknown';
  failures: number;
}
export type ProviderUsageSummary = Record<AIProvider, ProviderUsageSummaryItem>;
