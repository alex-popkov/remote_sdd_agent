/**
 * Local per-model pricing used for run.json cost accounting and the
 * MAX_COST_USD kill-switch (run-observability spec). Rates are Anthropic
 * first-party list prices in USD per million tokens. Bump deliberately when
 * prices change or the agents move to a new model.
 *
 * Cache writes are priced at the 1-hour TTL rate (2x input) — the CLI writes
 * 1h cache entries, and when unsure we'd rather over- than under-count so the
 * kill-switch errs on the safe side.
 */
export interface ModelRate {
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
}

const CACHE_WRITE_MULTIPLIER = 2;

// Keyed by model-id prefix: the CLI reports ids like `claude-haiku-4-5-20251001`
// or `claude-opus-4-7[1m]`, so lookup matches the longest key the id starts with.
export const MODEL_PRICING: Record<string, ModelRate> = {
  'claude-fable-5-1': { inputUsdPerMtok: 10, outputUsdPerMtok: 50, cacheReadUsdPerMtok: 0.25 },
  'claude-fable-5': { inputUsdPerMtok: 10, outputUsdPerMtok: 50, cacheReadUsdPerMtok: 1 },
  'claude-opus-5-5': { inputUsdPerMtok: 4, outputUsdPerMtok: 20, cacheReadUsdPerMtok: 0.2 },
  'claude-opus-5': { inputUsdPerMtok: 5, outputUsdPerMtok: 25, cacheReadUsdPerMtok: 0.5 },
  'claude-opus-4-8': { inputUsdPerMtok: 5, outputUsdPerMtok: 25, cacheReadUsdPerMtok: 0.5 },
  'claude-opus-4-7': { inputUsdPerMtok: 5, outputUsdPerMtok: 25, cacheReadUsdPerMtok: 0.5 },
  'claude-opus-4-6': { inputUsdPerMtok: 5, outputUsdPerMtok: 25, cacheReadUsdPerMtok: 0.5 },
  'claude-sonnet-5': { inputUsdPerMtok: 2, outputUsdPerMtok: 10, cacheReadUsdPerMtok: 0.2 },
  'claude-sonnet-4-6': { inputUsdPerMtok: 3, outputUsdPerMtok: 15, cacheReadUsdPerMtok: 0.3 },
  'claude-haiku-4-5': { inputUsdPerMtok: 1, outputUsdPerMtok: 5, cacheReadUsdPerMtok: 0.1 },
};

/** Used for ids missing from the table: the priciest rate, so the kill-switch never under-counts. */
export const FALLBACK_RATE: ModelRate = MODEL_PRICING['claude-fable-5-1'];

export function rateFor(modelId: string): { rate: ModelRate; known: boolean } {
  const key = Object.keys(MODEL_PRICING)
    .filter(k => modelId.startsWith(k))
    .sort((a, b) => b.length - a.length)[0];
  return key ? { rate: MODEL_PRICING[key], known: true } : { rate: FALLBACK_RATE, known: false };
}

export interface ModelUsage {
  model: string;
  /** Uncached input tokens. */
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function costUsd(usage: ModelUsage): number {
  const { rate } = rateFor(usage.model);
  return (
    (usage.inputTokens * rate.inputUsdPerMtok +
      usage.cacheWriteTokens * rate.inputUsdPerMtok * CACHE_WRITE_MULTIPLIER +
      usage.cacheReadTokens * rate.cacheReadUsdPerMtok +
      usage.outputTokens * rate.outputUsdPerMtok) /
    1_000_000
  );
}
