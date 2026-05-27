import { AIProvider, AIRequest, AIResponse } from "../types";

// ============================================================================
// Model Routing Configuration
// ============================================================================

export const MODEL_ROUTING = {
  intent: { // Prioritize Gemini Flash, then DeepSeek, then Groq
    primary: "gemini/gemini-1.5-flash",
    fallback: "deepseek/deepseek-chat",
    secondaryFallback: "groq/llama-3.3-70b-versatile",
  },
  schema: { // Prioritize Gemini Flash, then DeepSeek, then Groq
    primary: "gemini/gemini-1.5-flash",
    fallback: "deepseek/deepseek-chat",
    secondaryFallback: "groq/llama-3.3-70b-versatile",
  },
  spec: { // Prioritize Gemini Flash, then DeepSeek, then Groq
    primary: "gemini/gemini-1.5-flash",
    fallback: "deepseek/deepseek-chat",
    secondaryFallback: "groq/llama-3.3-70b-versatile",
  },
} as const;

// ============================================================================
// AI Gateway Interface
// ============================================================================

export interface AIGateway {
  send(request: AIRequest): Promise<AIResponse>;
  validateProvider(provider: AIProvider): boolean;
  getAvailableModels(provider: AIProvider): string[];
}

// ============================================================================
// Provider Configuration
// ============================================================================

interface ProviderConfig {
  apiKey: string;
  baseUrl?: string;
  timeout?: number;
}

interface ProviderRegistry {
  openai?: ProviderConfig;
  groq?: ProviderConfig;
  gemini?: ProviderConfig;
  anthropic?: ProviderConfig;
  mistral?: ProviderConfig; // Keep for future expansion
  deepseek?: ProviderConfig;
  openrouter?: ProviderConfig;
}

async function readProviderError(response: Response): Promise<string> {
  const text = await response.text().catch(() => "");
  if (!text) return `${response.status} ${response.statusText}`;

  try { // Explicitly type parsed
    const parsed = JSON.parse(text) as {
      error?: { message?: string } | string;
      message?: string;
    };
    if (typeof parsed.error === "string") return parsed.error;
    if (parsed.error?.message) return parsed.error.message;
    if (parsed.message) return parsed.message;
  } catch {
    // Keep the raw body below.
  }

  return text.slice(0, 500);
}

function requireContent(content: string | undefined, provider: AIProvider): string {
  if (!content || !content.trim()) {
    throw new Error(`${provider} returned an empty response`);
  }
  return content;
}

// ============================================================================
// Provider Health Cache
// ============================================================================

const PROVIDER_HEALTH_COOLDOWNS_MS = {
  quota: 15 * 60 * 1000,
  rate_limit: 2 * 60 * 1000,
  timeout: 60 * 1000,
  transient: 30 * 1000,
} as const;

const HEALTH_LOG_COOLDOWN_MS = 60 * 1000;

interface ProviderHealthState {
  unhealthyUntil: number;
  reason: string;
  lastLoggedAt: number;
}

class ProviderHealthCache {
  private states = new Map<AIProvider, ProviderHealthState>();

  isHealthy(provider: AIProvider): boolean {
    const state = this.states.get(provider);
    if (!state) return true;

    if (Date.now() >= state.unhealthyUntil) {
      this.states.delete(provider);
      return true;
    }

    return false;
  }

  getReason(provider: AIProvider): string | undefined {
    const state = this.states.get(provider);
    if (!state) return undefined;

    if (Date.now() >= state.unhealthyUntil) {
      this.states.delete(provider);
      return undefined;
    }

    return state.reason;
  }

  markFailure(provider: AIProvider, error: unknown): void {
    const message = this._errorMessage(error);
    const cooldownMs = this._cooldownForError(message);
    this.states.set(provider, {
      unhealthyUntil: Date.now() + cooldownMs,
      reason: message,
      lastLoggedAt: this.states.get(provider)?.lastLoggedAt ?? 0,
    });
  }

  shouldLog(provider: AIProvider): boolean {
    const state = this.states.get(provider);
    if (!state) return true;

    const now = Date.now();
    if (now - state.lastLoggedAt < HEALTH_LOG_COOLDOWN_MS) {
      return false;
    }

    state.lastLoggedAt = now;
    return true;
  }

  private _cooldownForError(message: string): number {
    const normalized = message.toLowerCase();
    if (normalized.includes("quota") || normalized.includes("billing")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.quota;
    }
    if (normalized.includes("rate limit") || normalized.includes("429")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.rate_limit;
    }
    if (normalized.includes("abort") || normalized.includes("timeout")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.timeout;
    }
    return PROVIDER_HEALTH_COOLDOWNS_MS.transient;
  }

  private _errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

const globalHealthRef = globalThis as unknown as {
  __ONEATLAS_PROVIDER_HEALTH?: ProviderHealthCache;
};

const providerHealth =
  globalHealthRef.__ONEATLAS_PROVIDER_HEALTH ??
  (globalHealthRef.__ONEATLAS_PROVIDER_HEALTH = new ProviderHealthCache());

// ============================================================================
// OpenAI Provider
// ============================================================================

interface OpenAIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenAIRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
}

interface OpenAIResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

class OpenAIProvider {
  private apiKey: string;
  private baseUrl: string = "https://api.openai.com/v1";

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("OpenAI API key not provided");
    this.apiKey = apiKey;
  }

  async send(
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number | undefined, // Explicitly type temperature
    max_tokens?: number,
    timeout: number = 30000
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body: OpenAIRequest = {
      model,
      messages: messages as OpenAIMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`OpenAI API error: ${await readProviderError(response)}`);
      }

      const data = (await response.json()) as OpenAIResponse;
      const content = requireContent(data.choices?.[0]?.message?.content, "openai");

      return {
        content,
        model,
        provider: "openai",
        usage: {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        },
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ============================================================================
// Groq Provider
// ============================================================================

interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface GroqResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

class GroqProvider {
  private apiKey: string;
  private baseUrl: string = "https://api.groq.com/openai/v1";

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("Groq API key not provided");
    this.apiKey = apiKey;
  }

  async send(
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number | undefined, // Explicitly type temperature
    max_tokens?: number,
    timeout: number = 30000
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body = {
      model,
      messages: messages as GroqMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`Groq API error: ${await readProviderError(response)}`);
      }

      const data = (await response.json()) as GroqResponse;
      const content = requireContent(data.choices?.[0]?.message?.content, "groq");

      return {
        content,
        model,
        provider: "groq",
        usage: {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        },
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ============================================================================
// Gemini Provider
// ============================================================================

interface GeminiContent {
  role: "user" | "model";
  parts: Array<{ text: string }>;
}

interface GeminiResponse {
  candidates: Array<{
    content: {
      parts: Array<{ text: string }>;
    };
  }>;
  usageMetadata?: {
    promptTokenCount: number;
    candidatesTokenCount: number;
    totalTokenCount: number;
  };
}

class GeminiProvider {
  private apiKey: string;
  private baseUrl: string = "https://generativelanguage.googleapis.com/v1beta/models";

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("Gemini API key not provided");
    this.apiKey = apiKey;
  }

  async send(
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number | undefined, // Explicitly type temperature
    max_tokens?: number,
    timeout: number = 30000
  ): Promise<AIResponse> {
    const contents: GeminiContent[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body = {
      contents,
      generationConfig: {
        temperature: temperature ?? 0.7,
        maxOutputTokens: max_tokens ?? 2048,
      },
    };

    const inputText = messages.map((message) => message.content).join("\n");
    const candidateModels = uniqueModels([
      model,
      "gemini-1.5-flash",
      "gemini-2.0-flash",
      "gemini-2.5-flash",
    ]);

    let lastError: Error | null = null;
    for (const candidateModel of candidateModels) {
      const startTime = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      try {
        const response = await fetch(
          `${this.baseUrl}/${candidateModel}:generateContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: controller.signal,
          }
        );

        if (!response.ok) {
          const providerError = await readProviderError(response);
          lastError = new Error(`Gemini API error: ${providerError}`);
          if (response.status === 404 && providerError.toLowerCase().includes("not found")) {
            continue;
          }
          throw lastError;
        }

        const data = (await response.json()) as GeminiResponse;
        const content = requireContent(
          data.candidates?.[0]?.content?.parts?.map((part) => part.text).join(""),
          "gemini"
        );
        const inputTokens = data.usageMetadata?.promptTokenCount ?? estimateTokens(inputText);
        const outputTokens = data.usageMetadata?.candidatesTokenCount ?? estimateTokens(content);

        return {
          content,
          model: candidateModel,
          provider: "gemini",
          usage: {
            input_tokens: inputTokens,
            output_tokens: outputTokens,
            total_tokens: data.usageMetadata?.totalTokenCount ?? inputTokens + outputTokens,
          },
          latency_ms: Date.now() - startTime,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    }

    throw lastError ?? new Error("Gemini API error: no compatible model available");
  }
}

// ============================================================================
// DeepSeek Provider
// ============================================================================

interface DeepSeekMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface DeepSeekResponse {
  choices: Array<{
    message: {
      content: string;
    };
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

class DeepSeekProvider {
  private apiKey: string;
  private baseUrl: string = "https://api.deepseek.com/v1";

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("DeepSeek API key not provided");
    this.apiKey = apiKey;
  }

  async send(
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number | undefined, // Explicitly type temperature
    max_tokens?: number,
    timeout: number = 33000 // DeepSeek can sometimes be a bit slower
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body = {
      model,
      messages: messages as DeepSeekMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new Error(`DeepSeek API error: ${await readProviderError(response)}`);
      }

      const data = (await response.json()) as DeepSeekResponse;
      const content = requireContent(data.choices?.[0]?.message?.content, "deepseek");

      return {
        content,
        model,
        provider: "deepseek",
        usage: {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        },
        latency_ms: Date.now() - startTime,
      };
    } finally {
      clearTimeout(timeoutId);
    }
  }
}

// ============================================================================
// Multi-Provider Gateway
// ============================================================================

export class MultiProviderGateway implements AIGateway {
  private providers: Map<AIProvider, OpenAIProvider | GroqProvider | GeminiProvider | DeepSeekProvider>;

  constructor(config: ProviderRegistry) {
    this.providers = new Map();

    if (config.openai) {
      this.providers.set("openai", new OpenAIProvider(config.openai.apiKey));
    }
    if (config.groq) {
      this.providers.set("groq", new GroqProvider(config.groq.apiKey));
    }
    if (config.gemini) {
      this.providers.set("gemini", new GeminiProvider(config.gemini.apiKey));
    }
    if (config.deepseek) {
      this.providers.set("deepseek", new DeepSeekProvider(config.deepseek.apiKey));
    }
  }

  async send(request: AIRequest): Promise<AIResponse> {
    const provider = this.providers.get(request.provider);

    if (!provider) { // Type guard for provider
      throw new Error(
        `Provider ${request.provider} not configured or not available`
      );
    }

    if (request.provider === "openai") {
      return (provider as OpenAIProvider).send( // Cast to specific provider
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    }
    if (request.provider === "groq") { // Use if for type narrowing
      return (provider as GroqProvider).send( // Cast to specific provider
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    }
    if (request.provider === "gemini") { // Use if for type narrowing
      return (provider as GeminiProvider).send( // Cast to specific provider
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    }
    if (request.provider === "deepseek") { // Use if for type narrowing
      return (provider as DeepSeekProvider).send( // Cast to specific provider
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    }

    throw new Error(`Unsupported provider: ${request.provider}`);
  }

  validateProvider(provider: AIProvider): boolean {
    if (provider === "anthropic" || provider === "mistral" || provider === "openrouter") {
      // Stub providers - return false until implemented
      return false; // These are stubs, so they are not validated as available
    }
    return this.providers.has(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    if (provider === "openai") {
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
    } else if (provider === "groq") {
      return ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"];
    }
    if (provider === "gemini") { // Use if for type narrowing
      return ["gemini-2.0-flash", "gemini-1.5-pro", "gemini-1.5-flash"]; // Added gemini-1.5-flash
    }
    // DeepSeek is now a real provider, so it should be handled here
    if (provider === "deepseek") {
      return ["deepseek-chat", "deepseek-coder"];
    }
    return [];
  }
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

function uniqueModels(models: string[]): string[] {
  return Array.from(new Set(models.filter(Boolean)));
}

// ============================================================================
// Mock Gateway (development / demo mode)
// ============================================================================

class MockGateway implements AIGateway {
  validateProvider(_provider: AIProvider): boolean {
    // Mock gateway acts as if every supported provider is available.
    return true;
  }

  getAvailableModels(_provider: AIProvider): string[] {
    return ["gemini-1.5-flash"];
  }

  async send(request: AIRequest): Promise<AIResponse> {
    // Determine stage heuristically from system prompt
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";

    const now = Date.now();

    if (system.includes("Extract the app intent")) {
      const content = JSON.stringify({
        appName: "Mock Task Manager",
        appType: "project_management",
        features: ["tasks", "assignments", "notifications"],
        entities: ["Task", "User"],
        integrations_requested: ["slack"],
        assumptions: ["users are internal"]
      });

      return {
        content,
        model: "gemini-1.5-flash",
        provider: "openai",
        usage: { input_tokens: 5, output_tokens: 50, total_tokens: 55 },
        latency_ms: Date.now() - now,
      };
    }

    if (system.includes("Generate a complete data schema")) {
      const content = JSON.stringify({
        schema_version: "1.0.0",
        entities: [
          {
            name: "Task",
            tableName: "tasks",
            fields: [
              { name: "id", type: "uuid", required: true },
              { name: "tenantId", type: "uuid", required: true },
              { name: "title", type: "string", required: true },
              { name: "dueDate", type: "date", required: false }
            ],
            relations: []
          }
        ]
      });

      return {
        content,
        model: "gemini-1.5-flash",
        provider: "groq",
        usage: { input_tokens: 5, output_tokens: 120, total_tokens: 125 },
        latency_ms: Date.now() - now,
      };
    }

    // Default: spec generation
    const spec = {
      metadata: {
        app_name: "Mock Task Manager",
        app_type: "project_management",
        version: "1.0.0",
        created_at: new Date().toISOString(),
      },
      data_schema: {
        schema_version: "1.0.0",
        entities: [
          {
            name: "Task",
            tableName: "tasks",
            fields: [
              { name: "id", type: "uuid", required: true },
              { name: "tenantId", type: "uuid", required: true },
              { name: "title", type: "string", required: true },
            ],
            relations: []
          }
        ]
      },
      pages: [
        { name: "home", path: "/", title: "Home", requires_auth: false, components: ["task-list"] }
      ],
      api_endpoints: [
        { path: "/api/tasks", method: "GET", entity: "Task", auth_required: false, response_type: "json" }
      ],
      auth_rules: [],
      integration_hooks: [ { integration_id: "slack", trigger: "message", action: "send_message", entity_mapping: {} } ],
      workflows: [],
      assumptions: []
    };

    return {
      content: JSON.stringify(spec),
      model: "gemini-1.5-flash",
      provider: "gemini",
      usage: { input_tokens: 5, output_tokens: 200, total_tokens: 205 },
      latency_ms: Date.now() - now,
    };
  }
}

export { MockGateway };

// ============================================================================
// Graceful Fallback Handler
// ============================================================================

export class AIGatewayWithFallback implements AIGateway {
  constructor(private gateway: AIGateway) {}

  // If the internal gateway is a MockGateway, bypass complex fallback logic
  private isMockGateway(): boolean {
    return this.gateway instanceof MockGateway;
  }

  async send(request: AIRequest): Promise<AIResponse> {
    const attemptedProviders = new Set<AIProvider>();
    const unavailableReasons: string[] = [];

    // If the requested provider is available, try it first
    if (
      this.gateway.validateProvider(request.provider) &&
      providerHealth.isHealthy(request.provider)
    ) {
      if (this.isMockGateway()) {
        // If it's a mock gateway, just send the request directly without fallback logic
        return this.gateway.send(request);
      }

      try {
        attemptedProviders.add(request.provider);
        const response = await this.gateway.send(request);
        return response;
      } catch (err) {
        providerHealth.markFailure(request.provider, err);
        this._logProviderFailureOnce(
          request.provider,
          `Provider ${request.provider} failed; routing to fallback`,
          err
        );
        // fallthrough to fallback selection
      }
    } else if (!this.gateway.validateProvider(request.provider)) {
      unavailableReasons.push(`${request.provider}: not configured`);
      console.warn(`Provider ${request.provider} not configured, selecting fallback`);
    } else {
      unavailableReasons.push(
        `${request.provider}: ${providerHealth.getReason(request.provider) ?? "health cooldown"}`
      );
      this._logProviderSkipOnce(request.provider);
    }

    // Fallback selection order: prefer Gemini, then DeepSeek, then Groq, then OpenAI
    const fallbackOrder: AIProvider[] = ["gemini", "deepseek", "groq", "openai"];

    // Default model mapping per provider (safe fallbacks)
    const DEFAULT_MODEL: Record<AIProvider, string> = {
      gemini: "gemini-1.5-flash", // Prefer flash for speed/cost
      deepseek: "deepseek-chat",
      groq: "llama-3.3-70b-versatile", // Groq's fast model
      openai: "gpt-4o-mini", // OpenAI's cost-effective model
      anthropic: "",
      mistral: "",
      openrouter: "",
    };

    let lastError: Error | null = null;
    for (const candidate of fallbackOrder) {
      if (attemptedProviders.has(candidate)) continue;
      if (!this.gateway.validateProvider(candidate)) {
        unavailableReasons.push(`${candidate}: not configured`);
        continue;
      }
      if (!providerHealth.isHealthy(candidate)) {
        unavailableReasons.push(
          `${candidate}: ${providerHealth.getReason(candidate) ?? "health cooldown"}`
        );
        this._logProviderSkipOnce(candidate);
        continue;
      }
      
      // Use the specific model from MODEL_ROUTING if available for the candidate provider,
      // otherwise fall back to the default model for that provider, then to the request model.
      // The model routing is handled by PipelineExecutor. Here, we just try the default model for the fallback provider.
      const chosenModel = DEFAULT_MODEL[candidate] || request.model;
      try {
        const fallbackRequest: AIRequest = {
          ...request,
          provider: candidate,
          model: chosenModel,
        };
        if (candidate !== request.provider) {
          console.info(`Routing request to fallback provider ${candidate}/${chosenModel}`);
        }
        return await this.gateway.send(fallbackRequest);
      } catch (err) {
        providerHealth.markFailure(candidate, err);
        lastError = err as Error;
        this._logProviderFailureOnce(
          candidate,
          `Fallback provider ${candidate} failed; trying next provider`,
          err
        );
      }
    }

    throw lastError ?? new Error(`No available providers could fulfill the request (${unavailableReasons.join("; ")})`);
  }

  validateProvider(provider: AIProvider): boolean {
    return this.gateway.validateProvider(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    return this.gateway.getAvailableModels(provider);
  }

  private _logProviderFailureOnce(
    provider: AIProvider,
    message: string,
    error: unknown
  ): void {
    if (!providerHealth.shouldLog(provider)) return;
    console.warn(message, error);
  }

  private _logProviderSkipOnce(provider: AIProvider): void {
    if (!providerHealth.shouldLog(provider)) return;
    const reason = providerHealth.getReason(provider) ?? "temporary provider health cooldown";
    console.info(`Skipping unhealthy provider ${provider}: ${reason}`);
  }
}
