import fs from 'node:fs';
import * as runJson from './runJson';
import { costUsd, rateFor, type ModelUsage } from './pricing';
import type { StageRecord } from '../../shared/src/types';

/**
 * Per-stage cost accounting, invoked by pipeline.sh after every stage:
 *
 *   node recordStage.js <runDir> <stage> <attempts> <exitCode> <startMarker> [usage.json ...]
 *
 * Each usage.json is the stdout of one `claude -p --output-format json`
 * attempt. Token counts come from its `modelUsage` map (per model, with the
 * cache split); cost is computed locally from pricing.ts. durationMs is "now"
 * minus the start marker's mtime, so it spans every retry attempt. The stage
 * record is appended to run.json and the new run total is printed on stdout
 * for pipeline.sh's MAX_COST_USD check.
 */

interface ClaudeResult {
  modelUsage?: Record<
    string,
    {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheCreationInputTokens?: number;
    }
  >;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

/**
 * Parse one attempt's CLI output into per-model usage. Prefers `modelUsage`
 * (one entry per model the session touched); falls back to the aggregate
 * `usage` block priced as an unknown model. Unparseable/empty output (the CLI
 * crashed before printing) yields no usage — there is nothing to count.
 */
export function parseClaudeResult(text: string): ModelUsage[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  let result: ClaudeResult;
  try {
    // The JSON result is the last line; anything before it is stray output.
    result = JSON.parse(trimmed.slice(trimmed.lastIndexOf('\n') + 1)) as ClaudeResult;
  } catch {
    return [];
  }

  if (result.modelUsage && Object.keys(result.modelUsage).length > 0) {
    return Object.entries(result.modelUsage).map(([model, u]) => ({
      model,
      inputTokens: u.inputTokens ?? 0,
      outputTokens: u.outputTokens ?? 0,
      cacheReadTokens: u.cacheReadInputTokens ?? 0,
      cacheWriteTokens: u.cacheCreationInputTokens ?? 0,
    }));
  }
  if (result.usage) {
    return [
      {
        model: 'unknown',
        inputTokens: result.usage.input_tokens ?? 0,
        outputTokens: result.usage.output_tokens ?? 0,
        cacheReadTokens: result.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: result.usage.cache_creation_input_tokens ?? 0,
      },
    ];
  }
  return [];
}

export function buildStageRecord(
  name: string,
  attempts: number,
  exitCode: number,
  durationMs: number,
  usages: ModelUsage[],
): StageRecord {
  const sum = (f: (u: ModelUsage) => number) => usages.reduce((acc, u) => acc + f(u), 0);
  return {
    name,
    attempts,
    durationMs,
    inputTokens: sum(u => u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens),
    outputTokens: sum(u => u.outputTokens),
    cacheReadTokens: sum(u => u.cacheReadTokens),
    cacheWriteTokens: sum(u => u.cacheWriteTokens),
    models: [...new Set(usages.map(u => u.model))],
    costUsd: runJson.roundUsd(sum(costUsd)),
    exitCode,
  };
}

function main(argv: string[]): void {
  const [runDir, stage, attemptsRaw, exitCodeRaw, marker, ...usageFiles] = argv;
  if (!runDir || !stage || !attemptsRaw || !exitCodeRaw || !marker) {
    console.error('usage: recordStage <runDir> <stage> <attempts> <exitCode> <startMarker> [usage.json ...]');
    process.exit(2);
  }

  const usages = usageFiles.flatMap(file => {
    try {
      return parseClaudeResult(fs.readFileSync(file, 'utf-8'));
    } catch {
      return [];
    }
  });
  for (const u of usages) {
    if (!rateFor(u.model).known) {
      console.error(`[recordStage] no pricing for model "${u.model}" — using the fallback (highest) rate`);
    }
  }

  let durationMs = 0;
  try {
    durationMs = Math.max(0, Math.round(Date.now() - fs.statSync(marker).mtimeMs));
  } catch {
    console.error(`[recordStage] start marker ${marker} missing — durationMs=0`);
  }

  const record = buildStageRecord(stage, Number(attemptsRaw), Number(exitCodeRaw), durationMs, usages);
  const meta = runJson.appendStage(runDir, record);
  process.stdout.write(`${meta.totalCostUsd}\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}
