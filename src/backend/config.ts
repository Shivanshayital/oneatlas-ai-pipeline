// ============================================================================
// Configuration Module
// ============================================================================

import fs from "fs";
import path from "path";
import { MultiProviderGateway, AIGatewayWithFallback, MockGateway } from "./ai/gateway";
import type { AIProvider } from "./types";

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
  deepseek: {
    apiKey: string;
  };
  enable_mock_mode?: boolean;
  env: "development" | "production";
  port: number;
}

export function loadConfig(): Config {
  loadLocalEnvFiles();

  return {
    openai: {
      apiKey: readEnv("OPENAI_API_KEY"),
    },
    groq: {
      apiKey: readEnv("GROQ_API_KEY"),
    },
    gemini: {
      apiKey: readEnv("GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"),
    },
    deepseek: {
      apiKey: readEnv("DEEPSEEK_API_KEY"),
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

  if (!config.gemini.apiKey) {
    warnings.push("GEMINI_API_KEY is not set");
  }

  if (!config.deepseek.apiKey) {
    warnings.push("DEEPSEEK_API_KEY is not set");
  }

  if (!config.groq.apiKey) {
    warnings.push("GROQ_API_KEY is not set");
  }

  if (!config.openai.apiKey) {
    warnings.push("OPENAI_API_KEY is not set");
  }

  return warnings;
}

export function availableProviders(config: Config): AIProvider[] {
  const providers: AIProvider[] = [];
  if (config.openai.apiKey) providers.push("openai");
  if (config.groq.apiKey) providers.push("groq");
  if (config.gemini.apiKey) providers.push("gemini");
  if (config.deepseek.apiKey) providers.push("deepseek");
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
  if (config.deepseek.apiKey) registry.deepseek = { apiKey: config.deepseek.apiKey };

  const providers = availableProviders(config);

  if (providers.length === 0 && config.enable_mock_mode) {
    // Development mock mode - return a simple mock gateway
    return new AIGatewayWithFallback(new MockGateway());
  }

  const gateway = new MultiProviderGateway(registry);
  return new AIGatewayWithFallback(gateway);
}

function readEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key]?.trim();
    if (value) return value;
  }
  return "";
}

let envFilesLoaded = false;

function loadLocalEnvFiles(): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;

  for (const envFile of [".env.local", path.join("src", ".env.local")]) {
    const filePath = path.resolve(process.cwd(), envFile);
    if (!fs.existsSync(filePath)) continue;

    const contents = fs.readFileSync(filePath, "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const separatorIndex = trimmed.indexOf("=");
      if (separatorIndex <= 0) continue;

      const key = trimmed.slice(0, separatorIndex).trim();
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || process.env[key]) continue;

      let value = trimmed.slice(separatorIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      process.env[key] = value;
    }
  }
}
