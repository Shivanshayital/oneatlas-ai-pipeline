// ============================================================================
// Configuration Module
// ============================================================================

import { MultiProviderGateway, AIGatewayWithFallback, MockGateway } from "./ai/gateway";

export interface Config {
  openai: {
    apiKey: string;
  };
  groq: {
    apiKey: string;
  };
  gemini: {
    apiKey: string;
  };
  enable_mock_mode?: boolean;
  env: "development" | "production";
  port: number;
}

export function loadConfig(): Config {
  return {
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
    },
    groq: {
      apiKey: process.env.GROQ_API_KEY || "",
    },
    gemini: {
      apiKey: process.env.GEMINI_API_KEY || "",
    },
    enable_mock_mode: typeof process.env.ENABLE_MOCK_MODE !== "undefined"
      ? process.env.ENABLE_MOCK_MODE === "true"
      : (process.env.NODE_ENV || "development") !== "production",
    env: (process.env.NODE_ENV as "development" | "production") || "development",
    port: parseInt(process.env.PORT || "3000"),
  };
}

export function validateConfig(config: Config): string[] {
  // Backwards-compatible: return configuration warnings instead of hard errors.
  const warnings: string[] = [];

  if (!config.openai.apiKey) {
    warnings.push("OPENAI_API_KEY is not set");
  }

  if (!config.groq.apiKey) {
    warnings.push("GROQ_API_KEY is not set");
  }

  if (!config.gemini.apiKey) {
    warnings.push("GEMINI_API_KEY is not set");
  }

  return warnings;
}

export function availableProviders(config: Config): string[] {
  const providers: string[] = [];
  if (config.openai.apiKey) providers.push("openai");
  if (config.groq.apiKey) providers.push("groq");
  if (config.gemini.apiKey) providers.push("gemini");
  return providers;
}

export function configurationWarnings(config: Config): string[] {
  return validateConfig(config);
}

export function validateEnvironment(config: Config): { ok: boolean; warnings: string[] } {
  const warnings = configurationWarnings(config);
  const providers = availableProviders(config);
  return { ok: providers.length > 0 || Boolean(config.enable_mock_mode), warnings };
}

export function initializePipeline(config: Config): AIGatewayWithFallback {
  // Only pass configured providers to the MultiProviderGateway so
  // individual provider constructors aren't invoked with empty keys.
  const registry: Record<string, { apiKey: string } | undefined> = {};
  if (config.openai.apiKey) registry.openai = { apiKey: config.openai.apiKey };
  if (config.groq.apiKey) registry.groq = { apiKey: config.groq.apiKey };
  if (config.gemini.apiKey) registry.gemini = { apiKey: config.gemini.apiKey };

  const providers = availableProviders(config);

  if (providers.length === 0 && config.enable_mock_mode) {
    // Development mock mode - return a simple mock gateway
    return new AIGatewayWithFallback(new (MockGateway as any)() as any);
  }

  const gateway = new MultiProviderGateway(registry as any);
  return new AIGatewayWithFallback(gateway);
}
