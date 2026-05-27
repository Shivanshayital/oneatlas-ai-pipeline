// ============================================================================
// Configuration Module
// ============================================================================

import { MultiProviderGateway } from "./ai/gateway";
import { PipelineOrchestrator } from "./pipeline/orchestrator";

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
    env: (process.env.NODE_ENV as "development" | "production") || "development",
    port: parseInt(process.env.PORT || "3000"),
  };
}

export function validateConfig(config: Config): string[] {
  const errors: string[] = [];

  if (!config.openai.apiKey) {
    errors.push("OPENAI_API_KEY environment variable is not set");
  }

  if (!config.groq.apiKey) {
    errors.push("GROQ_API_KEY environment variable is not set");
  }

  if (!config.gemini.apiKey) {
    errors.push("GEMINI_API_KEY environment variable is not set");
  }

  return errors;
}

export function initializePipeline(config: Config): PipelineOrchestrator {
  const gateway = new MultiProviderGateway({
    openai: { apiKey: config.openai.apiKey },
    groq: { apiKey: config.groq.apiKey },
    gemini: { apiKey: config.gemini.apiKey },
  });

  return new PipelineOrchestrator(gateway);
}
