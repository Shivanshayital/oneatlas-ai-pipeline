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
  private config: ProviderRegistry;

  constructor(config: ProviderRegistry) {
    this.config = config;
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
// Graceful Fallback Handler
// ============================================================================

export class AIGatewayWithFallback implements AIGateway {
  constructor(private gateway: MultiProviderGateway) {}

  async send(request: AIRequest): Promise<AIResponse> {
    const primaryModel = MODEL_ROUTING[request.provider as keyof typeof MODEL_ROUTING];

    if (!primaryModel) {
      throw new Error(`No routing configured for provider: ${request.provider}`);
    }

    try {
      return await this.gateway.send(request);
    } catch (error) {
      console.warn(
        `Primary model ${request.model} failed, attempting fallback`,
        error
      );
      // Fallback logic would be implemented here
      throw error;
    }
  }

  validateProvider(provider: AIProvider): boolean {
    return this.gateway.validateProvider(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    return this.gateway.getAvailableModels(provider);
  }
}
