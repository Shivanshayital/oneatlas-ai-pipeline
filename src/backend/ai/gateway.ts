import { AIProvider, AIRequest, AIResponse, ModelHealth } from "../types";
import { logger } from "../logging/logger";

// ============================================================================
// Model Routing Configuration
// ============================================================================

export const MODEL_ROUTING = {
  intent: {
    primary: "google/gemma-2-9b-it:free",
    fallback: "mistralai/mistral-7b-instruct:free",
  },

  schema: {
    primary: "google/gemma-2-9b-it:free",
    fallback: "mistralai/mistral-7b-instruct:free",
  },

  // Prefer faster instruct/free models for spec generation
  spec: {
    primary: "openrouter/google/gemma-2-9b-it:free",
    fallback: "openrouter/mistralai/mistral-7b-instruct:free",
    secondaryFallback: "openrouter/qwen/qwen-2.5-7b-instruct:free",
    tertiaryFallback: "deepseek/deepseek-chat",
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

type FailureType = DetailedProviderError["type"] | "transient";
const PROVIDER_REQUEST_TIMEOUT_MS = 30_000;
const OPENROUTER_DISCOVERY_TIMEOUT_MS = 5_000;
const MAX_PROVIDER_ATTEMPTS = 5;

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

export interface DetailedProviderError {
  message: string;
  type: 'rate_limit' | 'quota' | 'timeout' | 'context_length' | 'auth' | 'balance' | 'unavailable' | 'unknown';
  status: number;
}

async function readProviderError(response: Response): Promise<DetailedProviderError> {
  const text = await response.text().catch(() => "");
  let message = text || `${response.status} ${response.statusText}`;
  let type: DetailedProviderError['type'] = 'unknown';

  try {
    const parsed = JSON.parse(text) as {
      error?: { message?: string; code?: string } | string;
      message?: string;
    };
    message = (typeof parsed.error === "string" ? parsed.error : parsed.error?.message) || parsed.message || message;
  } catch {}

  const normalized = message.toLowerCase();
  if (response.status === 429 || normalized.includes("rate_limit") || normalized.includes("provider returned error")) {
    type = 'rate_limit';
  }
  else if (normalized.includes("quota") || normalized.includes("billing") || response.status === 402) type = 'quota';
  else if (normalized.includes("insufficient balance") || normalized.includes("credit")) type = 'balance';
  else if (response.status === 401 || response.status === 403) type = 'auth';
  else if (normalized.includes("context_length") || normalized.includes("too many tokens") || response.status === 413) type = 'context_length';
  else if (normalized.includes("timeout") || normalized.includes("abort")) type = 'timeout';
  else if (normalized.includes("no endpoints found") || normalized.includes("model not found") || normalized.includes("unavailable") || response.status === 404) type = 'unavailable';

  return {
    message: message.slice(0, 500),
    type,
    status: response.status
  };
}

function requireContent(content: string | undefined, provider: AIProvider): string {
  if (!content || !content.trim()) {
    throw new Error(`${provider} returned an empty response`);
  }
  return content;
}

// ============================================================================
// Provider/Model Resolution Helper
// ============================================================================

const OPENROUTER_SPECIFIC_MODELS: string[] = [
  "google/gemini-2.0-flash-exp:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  // Add any other OpenRouter models that don't start with "openrouter/" but should be routed there
];

const NATIVE_PROVIDERS: AIProvider[] = ["openai", "groq", "gemini", "deepseek"];

/**
 * Resolves the AI provider and model name from a route string.
 * This handles OpenRouter models which might have prefixes resembling native providers
 * but should be routed through the OpenRouter gateway.
 *
 * @param route The full model identifier string from MODEL_ROUTING (e.g., "openai/gpt-oss-20b:free" or "groq/llama-3.3-70b-versatile").
 * @returns An object containing the resolved provider and model.
 * @throws Error if the route format is unrecognized.
 */
export function resolveProviderAndModel(route: string): { provider: AIProvider; model: string } {
  // 1. Check for specific OpenRouter models that don't use the "openrouter/" prefix
  if (
    OPENROUTER_SPECIFIC_MODELS.includes(route) ||
    route.startsWith("meta-llama/") ||
    route.startsWith("google/") ||
    route.startsWith("mistralai/") ||
    route.includes(":free")
  ) {
    return {
      provider: "openrouter",
      model: route, // The entire route string is the model ID for OpenRouter in this case
    };
  }

  // 2. Check for routes explicitly prefixed with "openrouter/"
  if (route.startsWith("openrouter/")) {
    return {
      provider: "openrouter",
      model: route.substring("openrouter/".length),
    };
  }

  // 3. For native providers (e.g., "groq/llama-3.3-70b-versatile", "gemini/gemini-1.5-flash")
  const slashIndex = route.indexOf("/");
  if (slashIndex !== -1) {
    const providerPrefix = route.substring(0, slashIndex) as AIProvider;
    if (NATIVE_PROVIDERS.includes(providerPrefix)) {
      return {
        provider: providerPrefix,
        model: route.substring(slashIndex + 1),
      };
    }
  }

  logger.error(`[resolveProviderAndModel] Unrecognized route format or provider for: ${route}.`);
  throw new Error(`Unrecognized AI provider or model format: ${route}`);
}

// ============================================================================
// Provider Health Cache
// ============================================================================

const PROVIDER_HEALTH_COOLDOWNS_MS = {
  quota: 60 * 60 * 1000,        // 1 hour
  rate_limit: 15 * 60 * 1000,   // 15 minutes
  timeout: 2 * 60 * 1000,       // 2 minutes
  unavailable: 5 * 60 * 1000,   // 5 minutes
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
      logger.info(`Provider recovery: ${provider} is now healthy again.`);
      this.states.delete(provider);
      return true;
    }

    return false;
  }

  getCooldownUntil(provider: AIProvider): number | undefined {
    const state = this.states.get(provider);
    if (!state) return undefined;
    if (Date.now() >= state.unhealthyUntil) {
      this.states.delete(provider);
      return undefined;
    }
    return state.unhealthyUntil;
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
    const until = Date.now() + cooldownMs;
    
    logger.warn(`Provider cooldown start: ${provider} for ${cooldownMs / 1000}s. Reason: ${message}`);
    
    this.states.set(provider, {
      unhealthyUntil: until,
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
    if (normalized.includes("quota") || normalized.includes("billing") || normalized.includes("balance")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.quota;
    }
    if (normalized.includes("rate limit") || normalized.includes("429") || normalized.includes("provider returned error")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.rate_limit;
    }
    if (normalized.includes("abort") || normalized.includes("timeout")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.timeout;
    }
    if (normalized.includes("unavailable") || normalized.includes("no endpoints found") || normalized.includes("model not found")) {
      return PROVIDER_HEALTH_COOLDOWNS_MS.unavailable;
    }
    return PROVIDER_HEALTH_COOLDOWNS_MS.transient;
  }

  private _errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}

const globalHealthRef = globalThis as unknown as {
  __ONEATLAS_PROVIDER_HEALTH?: ProviderHealthCache;
  __ONEATLAS_MODEL_HEALTH?: Map<string, ModelHealth>;
  __ONEATLAS_OPENROUTER_MODEL_CACHE?: {
    fetchedAt: number;
    models: string[];
  };
};

export const providerHealth =
  globalHealthRef.__ONEATLAS_PROVIDER_HEALTH ??
  (globalHealthRef.__ONEATLAS_PROVIDER_HEALTH = new ProviderHealthCache());

export const modelHealthRegistry =
  globalHealthRef.__ONEATLAS_MODEL_HEALTH ??
  (globalHealthRef.__ONEATLAS_MODEL_HEALTH = new Map<string, ModelHealth>());

const OPENROUTER_DISCOVERY_CACHE_MS = 5 * 60 * 1000;
const MODEL_FAILURE_COOLDOWNS_MS: Record<FailureType, number> = {
  quota: 60 * 60 * 1000,
  balance: 60 * 60 * 1000,
  rate_limit: 15 * 60 * 1000,
  unavailable: 10 * 60 * 1000,
  timeout: 2 * 60 * 1000,
  context_length: 45 * 1000,
  auth: 60 * 60 * 1000,
  unknown: 90 * 1000,
  transient: 30 * 1000,
};

const OPENROUTER_SEED_MODELS = [
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "google/gemini-2.0-flash-exp:free",
  "openai/gpt-oss-20b:free",
  "moonshotai/kimi-k2:free",
];

function modelKey(provider: AIProvider, model: string): string {
  return `${provider}:${model}`;
}

function defaultModelHealth(provider: AIProvider, model: string): ModelHealth {
  return {
    provider,
    model,
    status: "healthy",
    failureCount: 0,
    successCount: 0,
  };
}

function getMutableModelHealth(provider: AIProvider, model: string): ModelHealth {
  const key = modelKey(provider, model);
  const existing = modelHealthRegistry.get(key);
  if (existing) {
    if (existing.cooldownUntil && Date.now() >= existing.cooldownUntil) {
      existing.status = existing.failureCount >= 5 && existing.successCount === 0 ? "failed" : "healthy";
      existing.cooldownUntil = undefined;
    }
    return existing;
  }

  const created = defaultModelHealth(provider, model);
  modelHealthRegistry.set(key, created);
  return created;
}

export function getModelHealth(provider: AIProvider, model: string): ModelHealth {
  return { ...getMutableModelHealth(provider, model) };
}

export function getModelHealthSnapshot(): ModelHealth[] {
  for (const health of modelHealthRegistry.values()) {
    getMutableModelHealth(health.provider, health.model);
  }
  return Array.from(modelHealthRegistry.values()).map((health) => ({ ...health }));
}

export function getModelHealthScore(provider: AIProvider, model: string): number {
  const health = getMutableModelHealth(provider, model);
  if (health.status === "cooldown" || health.status === "failed") return 0;

  const attempts = health.successCount + health.failureCount;
  const successRate = attempts > 0 ? health.successCount / attempts : 0.72;
  const latencyPenalty = health.averageLatency ? Math.min(0.35, health.averageLatency / 20000) : 0.08;
  const recencyBoost = health.lastSuccess ? Math.max(0, 0.1 - (Date.now() - health.lastSuccess) / 3_600_000) : 0;
  return Math.max(0.05, Math.min(1, successRate - latencyPenalty + recencyBoost));
}

function classifyFailure(error: unknown): FailureType {
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes("quota") || message.includes("billing")) return "quota";
  if (message.includes("balance") || message.includes("credit")) return "balance";
  if (message.includes("429") || message.includes("rate_limit") || message.includes("rate limit") || message.includes("provider returned error")) return "rate_limit";
  if (message.includes("no endpoints found") || message.includes("unavailable") || message.includes("model not found") || message.includes("404")) return "unavailable";
  if (message.includes("context_length") || message.includes("too many tokens")) return "context_length";
  if (message.includes("401") || message.includes("403") || message.includes("auth")) return "auth";
  if (message.includes("timeout") || message.includes("abort")) return "timeout";
  return "transient";
}

function isProviderWideFailure(type: FailureType): boolean {
  return type === "quota" || type === "balance" || type === "auth" || type === "rate_limit";
}

export function markModelSuccess(provider: AIProvider, model: string, latencyMs: number): void {
  const health = getMutableModelHealth(provider, model);
  health.status = "healthy";
  health.lastSuccess = Date.now();
  health.successCount += 1;
  health.cooldownUntil = undefined;
  health.averageLatency =
    health.averageLatency === undefined
      ? latencyMs
      : Math.round(health.averageLatency * 0.7 + latencyMs * 0.3);

  logger.info("Model success recorded", {
    provider,
    model,
    latencyMs,
    healthScore: getModelHealthScore(provider, model),
  });
}

export function markModelFailure(provider: AIProvider, model: string, error: unknown): FailureType {
  const type = classifyFailure(error);
  const health = getMutableModelHealth(provider, model);
  const cooldownMs = MODEL_FAILURE_COOLDOWNS_MS[type];

  health.status = health.failureCount >= 4 && health.successCount === 0 ? "failed" : "cooldown";
  health.lastFailure = Date.now();
  health.failureCount += 1;
  health.cooldownUntil = Date.now() + cooldownMs;

  logger.warn("Model cooldown start", {
    provider,
    model,
    failureType: type,
    cooldownMs,
    error: error instanceof Error ? error.message : String(error),
  });

  if (isProviderWideFailure(type)) {
    providerHealth.markFailure(provider, error);
  }

  return type;
}

export async function getHealthyOpenRouterModels(abortSignal?: AbortSignal): Promise<string[]> {
  const cached = globalHealthRef.__ONEATLAS_OPENROUTER_MODEL_CACHE;
  const now = Date.now();
  let discovered = cached && now - cached.fetchedAt < OPENROUTER_DISCOVERY_CACHE_MS
    ? cached.models
    : OPENROUTER_SEED_MODELS;

  if (!cached || now - cached.fetchedAt >= OPENROUTER_DISCOVERY_CACHE_MS) {
    const discoveryAbort = createAbortSignal(OPENROUTER_DISCOVERY_TIMEOUT_MS, abortSignal);
    try {
      const response = await fetch("https://openrouter.ai/api/v1/models", {
        headers: process.env.OPENROUTER_API_KEY
          ? { Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` }
          : undefined,
        signal: discoveryAbort.signal,
      });

      if (response.ok) {
        const payload = (await response.json()) as {
          data?: Array<{
            id?: string;
            pricing?: { prompt?: string; completion?: string };
          }>;
        };
        const freeModels =
          payload.data
            ?.filter((model) => {
              const promptPrice = Number(model.pricing?.prompt ?? "1");
              const completionPrice = Number(model.pricing?.completion ?? "1");
              return Boolean(model.id) && promptPrice === 0 && completionPrice === 0;
            })
            .map((model) => model.id as string) ?? [];

        discovered = uniqueModels([...freeModels, ...OPENROUTER_SEED_MODELS]);
        globalHealthRef.__ONEATLAS_OPENROUTER_MODEL_CACHE = {
          fetchedAt: now,
          models: discovered,
        };
      }
    } catch (error) {
      logger.warn("OpenRouter model discovery failed; using cached seed models", {
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      discoveryAbort.cleanup();
    }
  }

  const healthyModels = discovered
    .filter((model) => {
      const health = getMutableModelHealth("openrouter", model);
      return health.status === "healthy";
    })
    .sort((a, b) => getModelHealthScore("openrouter", b) - getModelHealthScore("openrouter", a));

  const boundedHealthyModels = healthyModels.slice(0, 5);

  return boundedHealthyModels.length > 0 ? boundedHealthyModels : OPENROUTER_SEED_MODELS.filter((model) => {
    const health = getMutableModelHealth("openrouter", model);
    return !health.cooldownUntil || Date.now() >= health.cooldownUntil;
  }).slice(0, 5);
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
  model?: string;
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
    timeout: number = PROVIDER_REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body: OpenAIRequest = {
      model,
      messages: messages as OpenAIMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 1024,
    };

    const { signal, cleanup } = createAbortSignal(Math.min(timeout, PROVIDER_REQUEST_TIMEOUT_MS), externalSignal);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const err = await readProviderError(response);
        throw new Error(`OpenAI [${err.type}]: ${err.message}`);
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
      cleanup();
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
    timeout: number = PROVIDER_REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body = {
      model,
      messages: messages as GroqMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 1024,
    };

    const { signal, cleanup } = createAbortSignal(Math.min(timeout, PROVIDER_REQUEST_TIMEOUT_MS), externalSignal);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const err = await readProviderError(response);
        throw new Error(`Groq [${err.type}]: ${err.message}`);
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
      cleanup();
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
    timeout: number = PROVIDER_REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<AIResponse> {
    const contents: GeminiContent[] = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const body = {
      contents,
      generationConfig: {
        temperature: temperature ?? 0.7,
        maxOutputTokens: max_tokens ?? 1024,
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
      const { signal, cleanup } = createAbortSignal(Math.min(timeout, PROVIDER_REQUEST_TIMEOUT_MS), externalSignal);

      try {
        const response = await fetch(
          `${this.baseUrl}/${candidateModel}:generateContent?key=${this.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal,
          }
        );

        if (!response.ok) {
          const providerError = await readProviderError(response);
          lastError = new Error(`Gemini [${providerError.type}]: ${providerError.message}`);
          if (response.status === 404 && providerError.message.toLowerCase().includes("not found")) {
            continue; // Try next candidate model
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
        cleanup();
      }
    }

    throw lastError ?? new Error("Gemini API error: no compatible model available");
  }
}

// ============================================================================
// OpenRouter Provider
// ============================================================================

class OpenRouterProvider {
  private apiKey: string;
  private baseUrl: string = "https://openrouter.ai/api/v1";

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("OpenRouter API key not provided");
    this.apiKey = apiKey;
  }

  async send(
    model: string,
    messages: Array<{ role: string; content: string }>,
    temperature: number | undefined,
    max_tokens?: number,
    timeout: number = PROVIDER_REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body = {
      model,
      messages,
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 1024,
    };

    const { signal, cleanup } = createAbortSignal(Math.min(timeout, PROVIDER_REQUEST_TIMEOUT_MS), externalSignal);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "https://oneatlas.ai", // OpenRouter requirement
          "X-Title": "OneAtlas AI Pipeline",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const err = await readProviderError(response);
        throw new Error(`OpenRouter [${err.type}]: ${err.message}`);
      }

      const data = (await response.json()) as OpenAIResponse; // OpenRouter is OpenAI-compatible
      const content = requireContent(data.choices?.[0]?.message?.content, "openrouter");

      return {
        content,
        model: data.model || model,
        provider: "openrouter",
        usage: {
          input_tokens: data.usage.prompt_tokens,
          output_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        },
        latency_ms: Date.now() - startTime,
      };
    } finally {
      cleanup();
    }
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
    timeout: number = PROVIDER_REQUEST_TIMEOUT_MS,
    externalSignal?: AbortSignal
  ): Promise<AIResponse> {
    const startTime = Date.now();

    const body = {
      model,
      messages: messages as DeepSeekMessage[],
      temperature: temperature ?? 0.7,
      max_tokens: max_tokens ?? 2048,
    };

    const { signal, cleanup } = createAbortSignal(Math.min(timeout, PROVIDER_REQUEST_TIMEOUT_MS), externalSignal);

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!response.ok) {
        const err = await readProviderError(response);
        throw new Error(`DeepSeek [${err.type}]: ${err.message}`);
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
      cleanup();
    }
  }
}

// ============================================================================
// Multi-Provider Gateway
// ============================================================================

export class MultiProviderGateway implements AIGateway {
  private providers: Map<AIProvider, OpenAIProvider | GroqProvider | GeminiProvider | DeepSeekProvider | OpenRouterProvider>;

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
    
    const openRouterKey = config.openrouter?.apiKey || process.env.OPENROUTER_API_KEY;
    if (openRouterKey) {
      this.providers.set("openrouter", new OpenRouterProvider(openRouterKey));
    }
  }

  async send(request: AIRequest): Promise<AIResponse> {
    const provider = this.providers.get(request.provider);

    if (!provider) { // Type guard for provider
      throw new Error(
        `Provider ${request.provider} not configured or not available`
      );
    }

    logger.info("Provider start", {
      stage: request.stage,
      provider: request.provider,
      model: request.model,
      timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
    });

    try {
      if (request.provider === "openai") {
        return await (provider as OpenAIProvider).send( // Cast to specific provider
          request.model,
          request.messages,
          request.temperature,
          request.max_tokens,
          PROVIDER_REQUEST_TIMEOUT_MS,
          request.abortSignal
        );
      }
      if (request.provider === "groq") { // Use if for type narrowing
        return await (provider as GroqProvider).send( // Cast to specific provider
          request.model,
          request.messages,
          request.temperature,
          request.max_tokens,
          PROVIDER_REQUEST_TIMEOUT_MS,
          request.abortSignal
        );
      }
      if (request.provider === "gemini") { // Use if for type narrowing
        return await (provider as GeminiProvider).send( // Cast to specific provider
          request.model,
          request.messages,
          request.temperature,
          request.max_tokens,
          PROVIDER_REQUEST_TIMEOUT_MS,
          request.abortSignal
        );
      }
      if (request.provider === "deepseek") { // Use if for type narrowing
        return await (provider as DeepSeekProvider).send( // Cast to specific provider
          request.model,
          request.messages,
          request.temperature,
          request.max_tokens,
          PROVIDER_REQUEST_TIMEOUT_MS,
          request.abortSignal
        );
      }
      if (request.provider === "openrouter") {
        return await (provider as OpenRouterProvider).send(
          request.model,
          request.messages,
          request.temperature,
          request.max_tokens,
          PROVIDER_REQUEST_TIMEOUT_MS,
          request.abortSignal
        );
      }
    } catch (error) {
      if (isAbortError(error) && !request.abortSignal?.aborted) {
        logger.warn("Provider timeout", {
          stage: request.stage,
          provider: request.provider,
          model: request.model,
          timeoutMs: PROVIDER_REQUEST_TIMEOUT_MS,
        });
      }
      throw error;
    }

    throw new Error(`Unsupported provider: ${request.provider}`);
  }

  validateProvider(provider: AIProvider): boolean {
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
    if (provider === "openrouter") {
      return [
        ...OPENROUTER_SEED_MODELS,
      ];
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
    const attemptedRoutes = new Set<string>();
    const unavailableReasons: string[] = [];
    const routes = await this._buildCandidateRoutes(request);
    let lastError: Error | null = null;

    if (this.isMockGateway()) {
      return this.gateway.send(request);
    }

    for (let attempt = 0; attempt < routes.length && attemptedRoutes.size < MAX_PROVIDER_ATTEMPTS; attempt += 1) {
      if (request.abortSignal?.aborted) {
        throw new Error(`Provider routing aborted for stage ${request.stage ?? "unknown"}`);
      }

      const route = routes[attempt];
      const key = modelKey(route.provider, route.model);
      if (attemptedRoutes.has(key)) continue;
      attemptedRoutes.add(key);

      if (!this.gateway.validateProvider(route.provider)) {
        unavailableReasons.push(`${route.provider}: not configured`);
        continue;
      }
      if (!providerHealth.isHealthy(route.provider)) {
        unavailableReasons.push(
          `${route.provider}: ${providerHealth.getReason(route.provider) ?? "health cooldown"}`
        );
        this._logProviderSkipOnce(route.provider);
        continue;
      }
      if (getModelHealthScore(route.provider, route.model) <= 0) {
        unavailableReasons.push(`${route.provider}/${route.model}: model cooldown`);
        continue;
      }

      try {
        const fallbackRequest: AIRequest = {
          ...request,
          provider: route.provider,
          model: route.model,
        };
        logger.info("Provider route attempt", {
          stage: request.stage,
          attempt: attemptedRoutes.size,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          provider: route.provider,
          model: route.model,
          healthScore: getModelHealthScore(route.provider, route.model),
          requestedProvider: request.provider,
          requestedModel: request.model,
        });
        const response = await this.gateway.send(fallbackRequest);
        markModelSuccess(response.provider, response.model, response.latency_ms);
        return response;
      } catch (err) {
        lastError = err as Error;
        const failureType = markModelFailure(route.provider, route.model, err);

        logger.warn("Fallback switch", {
          stage: request.stage,
          provider: route.provider,
          model: route.model,
          failureType,
          attempt: attemptedRoutes.size,
          maxAttempts: MAX_PROVIDER_ATTEMPTS,
          error: err instanceof Error ? err.message : String(err),
        });
        if (attemptedRoutes.size < MAX_PROVIDER_ATTEMPTS && !request.abortSignal?.aborted) {
          await sleep(backoffMs(attempt), request.abortSignal);
        }
      }
    }

    throw lastError ?? new Error(`No available providers could fulfill the request after ${attemptedRoutes.size} attempts (${unavailableReasons.join("; ")})`);
  }

  validateProvider(provider: AIProvider): boolean {
    return this.gateway.validateProvider(provider);
  }

  getAvailableModels(provider: AIProvider): string[] {
    return this.gateway.getAvailableModels(provider);
  }

  private _logProviderSkipOnce(provider: AIProvider): void {
    if (!providerHealth.shouldLog(provider)) return;
    const reason = providerHealth.getReason(provider) ?? "temporary provider health cooldown";
    console.info(`Skipping unhealthy provider ${provider}: ${reason}`);
  }

  private async _buildCandidateRoutes(request: AIRequest): Promise<Array<{ provider: AIProvider; model: string }>> {
    const providers: AIProvider[] = uniqueProviders([
      request.provider,
      "openrouter",
      "groq",
      "gemini",
      "deepseek",
    ]);

    const routes: Array<{ provider: AIProvider; model: string }> = [];
    for (const provider of providers) {
      if (!this.gateway.validateProvider(provider)) continue;
      if (provider === "openrouter") {
        const models = await getHealthyOpenRouterModels(request.abortSignal);
        const openRouterModels = request.provider === "openrouter"
          ? uniqueModels([request.model, ...models])
          : models;
        routes.push(...openRouterModels.map((model) => ({ provider, model })));
        continue;
      }

      const defaults = this._defaultModels(provider);
      const models = request.provider === provider
        ? uniqueModels([request.model, ...defaults])
        : defaults;
      routes.push(...models.map((model) => ({ provider, model })));
    }

    return routes.sort((a, b) => getModelHealthScore(b.provider, b.model) - getModelHealthScore(a.provider, a.model));
  }

  private _defaultModels(provider: AIProvider): string[] {
    if (provider === "groq") return ["llama-3.1-8b-instant", "llama-3.3-70b-versatile"];
    if (provider === "gemini") return ["gemini-2.0-flash", "gemini-1.5-flash"];
    if (provider === "deepseek") return ["deepseek-chat"];
    if (provider === "openai") return ["gpt-4o-mini"];
    return [];
  }
}

function uniqueProviders(providers: AIProvider[]): AIProvider[] {
  return Array.from(new Set(providers));
}

function backoffMs(attempt: number): number {
  const base = Math.min(2500, 200 * 2 ** attempt);
  return base + Math.floor(Math.random() * 250);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.reject(new Error("Sleep aborted"));
  }

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timeoutId);
      reject(new Error("Sleep aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function createAbortSignal(
  timeoutMs: number,
  externalSignal?: AbortSignal
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  const onExternalAbort = (): void => {
    controller.abort();
  };

  if (externalSignal?.aborted) {
    controller.abort();
  } else {
    externalSignal?.addEventListener("abort", onExternalAbort, { once: true });
  }

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeoutId);
      externalSignal?.removeEventListener("abort", onExternalAbort);
    },
  };
}
