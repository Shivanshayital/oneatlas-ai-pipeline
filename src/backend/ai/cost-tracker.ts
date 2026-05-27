import { AIProvider, TokenMetrics } from "../types";

// ============================================================================
// Token Pricing (per 1M tokens) - as of May 2026, subject to change
// ============================================================================

const TOKEN_PRICING_PER_MILLION_INPUT_USD: Record<string, number> = {
  "openai/gpt-4o": 5.00,
  "openai/gpt-4o-mini": 0.15,
  "openai/gpt-4-turbo": 10.00,
  "groq/llama-3.3-70b-versatile": 0.50, // Estimate, Groq pricing is per 1M tokens
  "groq/llama-3.1-8b-instant": 0.10, // Estimate
  "gemini/gemini-2.0-flash": 0.35, // Estimate, Gemini pricing is per 1k characters
  "gemini/gemini-1.5-pro": 3.50, // Estimate
  "gemini/gemini-1.5-flash": 0.35, // Estimate
  "gemini/gemini-2.0-flash-exp": 0.35, // Estimate
  "deepseek/deepseek-chat": 0.10, // Estimate, DeepSeek pricing is per 1M tokens
  "deepseek/deepseek-coder": 0.10, // Estimate
};

const TOKEN_PRICING_PER_MILLION_OUTPUT_USD: Record<string, number> = {
  "openai/gpt-4o": 15.00,
  "openai/gpt-4o-mini": 0.60,
  "openai/gpt-4-turbo": 30.00,
  "groq/llama-3.3-70b-versatile": 0.50, // Estimate
  "groq/llama-3.1-8b-instant": 0.10, // Estimate
  "gemini/gemini-2.0-flash": 0.70, // Estimate
  "gemini/gemini-1.5-pro": 10.50, // Estimate
  "gemini/gemini-1.5-flash": 0.70, // Estimate
  "gemini/gemini-2.0-flash-exp": 0.70, // Estimate
  "deepseek/deepseek-chat": 0.10, // Estimate
  "deepseek/deepseek-coder": 0.10, // Estimate
};

// ============================================================================
// Free Tier Quota Estimates (for session tracking)
// These are rough estimates and should be replaced with actual API calls
// or more precise tracking if available from providers.
// ============================================================================

const FREE_TIER_QUOTA_ESTIMATES: Partial<Record<AIProvider, { totalTokens: number; resetInterval: "daily" | "monthly" }>> = {
  openai: { totalTokens: 1_000_000, resetInterval: "monthly" }, // Example for GPT-4o mini
  groq: { totalTokens: 5_000_000, resetInterval: "monthly" }, // Generous estimate
  gemini: { totalTokens: 1_000_000, resetInterval: "monthly" }, // Example for Gemini Flash
  deepseek: { totalTokens: 1_000_000, resetInterval: "monthly" }, // Example
};

export class CostTracker {
  private totalInputTokens: number = 0;
  private totalOutputTokens: number = 0;
  private totalCostUsd: number = 0;
  private providerUsage: Map<AIProvider, { inputTokens: number; outputTokens: number; costUsd: number; requests: number }> = new Map();

  recordCost(model: string, inputTokens: number, outputTokens: number): number {
    const inputCost = (inputTokens / 1_000_000) * (TOKEN_PRICING_PER_MILLION_INPUT_USD[model] ?? 0);
    const outputCost = (outputTokens / 1_000_000) * (TOKEN_PRICING_PER_MILLION_OUTPUT_USD[model] ?? 0);
    const totalCallCost = inputCost + outputCost;

    this.totalInputTokens += inputTokens;
    this.totalOutputTokens += outputTokens;
    this.totalCostUsd += totalCallCost;

    const providerId = model.split('/')[0] as AIProvider;
    const currentUsage = this.providerUsage.get(providerId) || { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };
    currentUsage.inputTokens += inputTokens;
    currentUsage.outputTokens += outputTokens;
    currentUsage.costUsd += totalCallCost;
    currentUsage.requests += 1;
    this.providerUsage.set(providerId, currentUsage);

    return totalCallCost;
  }

  getTotals(): TokenMetrics {
    return {
      input_tokens: this.totalInputTokens,
      output_tokens: this.totalOutputTokens,
      total_tokens: this.totalInputTokens + this.totalOutputTokens,
      estimated_cost: this.totalCostUsd,
    };
  }

  getProviderUsage(provider: AIProvider): { inputTokens: number; outputTokens: number; costUsd: number; requests: number; totalTokens: number; estimatedRemainingQuota: number; quotaStatus: 'low' | 'medium' | 'high' | 'near_limit' | 'unknown' } { // Explicit return type
    const usage = this.providerUsage.get(provider) || { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };
    const totalTokens = usage.inputTokens + usage.outputTokens;
    const quotaInfo = FREE_TIER_QUOTA_ESTIMATES[provider];
    
    let estimatedRemainingQuota = 0;
    let quotaStatus: 'low' | 'medium' | 'high' | 'near_limit' | 'unknown' = 'unknown';

    if (quotaInfo) {
      estimatedRemainingQuota = Math.max(0, quotaInfo.totalTokens - totalTokens);
      const usagePercentage = (totalTokens / quotaInfo.totalTokens) * 100;
      if (usagePercentage < 50) quotaStatus = 'low';
      else if (usagePercentage < 80) quotaStatus = 'medium';
      else if (usagePercentage < 95) quotaStatus = 'high';
      else quotaStatus = 'near_limit';
    }

    return { ...usage, totalTokens, estimatedRemainingQuota, quotaStatus };
  }

  getAllProviderUsage(): Map<AIProvider, { inputTokens: number; outputTokens: number; costUsd: number; requests: number; totalTokens: number; estimatedRemainingQuota: number; quotaStatus: 'low' | 'medium' | 'high' | 'near_limit' | 'unknown' }> { // Explicit return type
    const allUsage = new Map<AIProvider, { inputTokens: number; outputTokens: number; costUsd: number; requests: number; totalTokens: number; estimatedRemainingQuota: number; quotaStatus: 'low' | 'medium' | 'high' | 'near_limit' | 'unknown' }>();
    for (const provider of Object.keys(FREE_TIER_QUOTA_ESTIMATES) as AIProvider[]) {
      allUsage.set(provider, this.getProviderUsage(provider));
    }
    return allUsage;
  }
}
