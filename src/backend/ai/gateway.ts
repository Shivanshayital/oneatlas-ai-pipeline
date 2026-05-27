import { AIProvider, AIRequest, AIResponse } from "../types";

// ============================================================================
// Model Routing Configuration
// ============================================================================

export const MODEL_ROUTING = {
  intent: {
    primary: "groq/llama-3.1-70b-versatile",
    fallback: "openai/gpt-4o-mini",
  },
  schema: {
    primary: "openai/gpt-4o",
    fallback: "gemini/gemini-2.0-flash",
  },
  spec: {
    primary: "openai/gpt-4o",
    fallback: "groq/llama-3.1-70b-versatile",
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
  mistral?: ProviderConfig;
  deepseek?: ProviderConfig;
  openrouter?: ProviderConfig;
}

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
    temperature?: number,
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
        const error = await response.json();
        throw new Error(`OpenAI API error: ${error.error?.message || "Unknown"}`);
      }

      const data = (await response.json()) as OpenAIResponse;

      return {
        content: data.choices[0].message.content,
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
    temperature?: number,
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
        const error = await response.json();
        throw new Error(
          `Groq API error: ${(error as Record<string, unknown>).error || "Unknown"}`
        );
      }

      const data = (await response.json()) as GroqResponse;

      return {
        content: data.choices[0].message.content,
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
  usageMetadata: {
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
    temperature?: number,
    max_tokens?: number,
    timeout: number = 30000
  ): Promise<AIResponse> {
    const startTime = Date.now();

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

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(
        `${this.baseUrl}/${model}:generateContent?key=${this.apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );

      if (!response.ok) {
        const error = await response.json();
        throw new Error(
          `Gemini API error: ${(error as Record<string, unknown>).error || "Unknown"}`
        );
      }

      const data = (await response.json()) as GeminiResponse;

      return {
        content: data.candidates[0].content.parts[0].text,
        model,
        provider: "gemini",
        usage: {
          input_tokens: data.usageMetadata.promptTokenCount,
          output_tokens: data.usageMetadata.candidatesTokenCount,
          total_tokens: data.usageMetadata.totalTokenCount,
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
  private providers: Map<AIProvider, OpenAIProvider | GroqProvider | GeminiProvider>;

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
  }

  async send(request: AIRequest): Promise<AIResponse> {
    const provider = this.providers.get(request.provider);

    if (!provider) {
      throw new Error(
        `Provider ${request.provider} not configured or not available`
      );
    }

    if (request.provider === "openai") {
      return (provider as OpenAIProvider).send(
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    } else if (request.provider === "groq") {
      return (provider as GroqProvider).send(
        request.model,
        request.messages,
        request.temperature,
        request.max_tokens,
        10000
      );
    } else if (request.provider === "gemini") {
      return (provider as GeminiProvider).send(
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
    if (provider === "anthropic" || provider === "mistral" || provider === "deepseek" || provider === "openrouter") {
      // Stub providers - return false until implemented
      return false;
    }
    return this.providers.has(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    if (provider === "openai") {
      return ["gpt-4o", "gpt-4o-mini", "gpt-4-turbo"];
    } else if (provider === "groq") {
      return ["llama-3.1-70b-versatile", "mixtral-8x7b-32768"];
    } else if (provider === "gemini") {
      return ["gemini-2.0-flash", "gemini-1.5-pro"];
    }
    return [];
  }
}

// ============================================================================
// Mock Gateway (development / demo mode)
// ============================================================================

class MockGateway implements AIGateway {
  validateProvider(_provider: AIProvider): boolean {
    // Mock gateway acts as if any provider is available
    return true;
  }

  getAvailableModels(_provider: AIProvider): string[] {
    return ["mock-model"];
  }

  async send(request: AIRequest): Promise<AIResponse> {
    // Determine stage heuristically from system prompt
    const system = request.messages.find((m) => m.role === "system")?.content ?? "";

    const now = Date.now();

    if (system.includes("Extract the app intent")) {
      const content = JSON.stringify({
        appName: "Mock Task Manager",
        appType: "web",
        features: ["tasks", "assignments", "notifications"],
        entities: ["Task", "User"],
        integrations_requested: ["slack"],
        assumptions: ["users are internal"]
      });

      return {
        content,
        model: "mock-model",
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
        model: "mock-model",
        provider: "groq",
        usage: { input_tokens: 5, output_tokens: 120, total_tokens: 125 },
        latency_ms: Date.now() - now,
      };
    }

    // Default: spec generation
    const spec = {
      metadata: {
        app_name: "Mock Task Manager",
        app_type: "web",
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
      model: "mock-model",
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
  constructor(private gateway: MultiProviderGateway) {}

  async send(request: AIRequest): Promise<AIResponse> {
    // If the requested provider is available, try it first
    if (this.gateway.validateProvider(request.provider)) {
      try {
        return await this.gateway.send(request);
      } catch (err) {
        console.warn(`Provider ${request.provider} failed, will attempt fallback`, err);
        // fallthrough to fallback selection
      }
    } else {
      console.warn(`Provider ${request.provider} not configured, selecting fallback`);
    }

    // Fallback selection order: prefer groq, then gemini, then openai
    const fallbackOrder: AIProvider[] = ["groq", "gemini", "openai"];

    // Default model mapping per provider (safe fallbacks)
    const DEFAULT_MODEL: Record<AIProvider, string> = {
      openai: "gpt-4o-mini",
      groq: "llama-3.1-70b-versatile",
      gemini: "gemini-2.0-flash",
      anthropic: "",
      mistral: "",
      deepseek: "",
      openrouter: "",
    };

    let lastError: Error | null = null;
    for (const candidate of fallbackOrder) {
      if (!this.gateway.validateProvider(candidate)) continue;
      const chosenModel = DEFAULT_MODEL[candidate] || request.model;
      try {
        const fallbackRequest: AIRequest = {
          ...request,
          provider: candidate,
          model: chosenModel,
        };
        console.info(`Routing request to fallback provider ${candidate}/${chosenModel}`);
        return await this.gateway.send(fallbackRequest);
      } catch (err) {
        lastError = err as Error;
        console.warn(`Fallback provider ${candidate} failed, trying next`, err);
      }
    }

    throw lastError ?? new Error("No available providers could fulfill the request");
  }

  validateProvider(provider: AIProvider): boolean {
    return this.gateway.validateProvider(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    return this.gateway.getAvailableModels(provider);
  }
}
