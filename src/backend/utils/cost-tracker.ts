// ============================================================================
// Cost and Latency Tracking
// ============================================================================

export interface CostEntry {
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  timestamp: string;
}

export interface TotalMetrics {
  total_input_tokens: number;
  total_output_tokens: number;
  total_tokens: number;
  total_cost_usd: number;
  entries: CostEntry[];
}

// Approximate token costs per 1M tokens
const COST_TABLE: Record<string, { input: number; output: number }> = {
  "gpt-4o": { input: 5.0, output: 15.0 },
  "gpt-4o-mini": { input: 0.15, output: 0.6 },
  "gpt-4-turbo": { input: 10.0, output: 30.0 },
  "llama-3.1-70b-versatile": { input: 0.59, output: 0.79 },
  "mixtral-8x7b-32768": { input: 0.27, output: 0.81 },
  "gemini-2.0-flash": { input: 0.075, output: 0.3 },
  "gemini-1.5-pro": { input: 1.25, output: 5.0 },
};

export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number {
  const costs = COST_TABLE[model] || { input: 0.1, output: 0.3 };

  const inputCost = (inputTokens / 1_000_000) * costs.input;
  const outputCost = (outputTokens / 1_000_000) * costs.output;

  return inputCost + outputCost;
}

export class CostTracker {
  private entries: CostEntry[] = [];

  recordCost(
    model: string,
    inputTokens: number,
    outputTokens: number
  ): number {
    const cost = calculateCost(model, inputTokens, outputTokens);

    this.entries.push({
      model,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: cost,
      timestamp: new Date().toISOString(),
    });

    return cost;
  }

  getTotals(): TotalMetrics {
    const totals = this.entries.reduce(
      (acc, entry) => ({
        input: acc.input + entry.input_tokens,
        output: acc.output + entry.output_tokens,
        cost: acc.cost + entry.cost_usd,
      }),
      { input: 0, output: 0, cost: 0 }
    );

    return {
      total_input_tokens: totals.input,
      total_output_tokens: totals.output,
      total_tokens: totals.input + totals.output,
      total_cost_usd: Math.round(totals.cost * 10000) / 10000, // Round to 4 decimals
      entries: this.entries,
    };
  }

  getEntries(): CostEntry[] {
    return [...this.entries];
  }

  reset(): void {
    this.entries = [];
  }
}
