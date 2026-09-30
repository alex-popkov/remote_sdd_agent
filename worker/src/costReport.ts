import type { RunMetadata } from '../../shared/src/types';

/**
 * Human-readable summaries of run.json's cost / failure data: the
 * failureReason strings and the cost-abort issue comment.
 */

function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

/** e.g. "cost ceiling exceeded: $5.10 >= $5.00 (task-researcher $1.20, task-planner $3.90)". */
export function costAbortReason(meta: RunMetadata, maxCostUsd: number): string {
  const breakdown = meta.stages.map(s => `${s.name} ${usd(s.costUsd)}`).join(', ');
  return (
    `cost ceiling exceeded: ${usd(meta.totalCostUsd)} >= ${usd(maxCostUsd)}` +
    (breakdown ? ` (${breakdown})` : '')
  );
}

/** Markdown comment posted on the source issue when the kill-switch fires. */
export function costAbortComment(meta: RunMetadata, maxCostUsd: number): string {
  const rows = meta.stages.map(
    s =>
      `| ${s.name} | ${s.attempts} | ${s.inputTokens.toLocaleString('en-US')} | ` +
      `${s.outputTokens.toLocaleString('en-US')} | ${usd(s.costUsd)} |`,
  );
  return [
    `🛑 The remote SDD agent stopped this run: cost ceiling reached ` +
      `(${usd(meta.totalCostUsd)} ≥ \`MAX_COST_USD\` ${usd(maxCostUsd)}). No pull request was opened.`,
    '',
    '| Stage | Attempts | Input tokens | Output tokens | Cost |',
    '|---|---:|---:|---:|---:|',
    ...rows,
    `| **Total** | | | | **${usd(meta.totalCostUsd)}** |`,
    '',
    `Run: \`${meta.triggerId}\``,
  ].join('\n');
}

/**
 * failureReason for a non-zero, non-cost pipeline exit. Names the stage that
 * hard-failed when run.json recorded one (the last stage, with a non-zero
 * exitCode), e.g. "stage task-executor exhausted 3 retries (pipeline exit 1)".
 */
export function pipelineFailureReason(meta: RunMetadata | null, exitCode: number): string {
  const last = meta?.stages[meta.stages.length - 1];
  if (last && last.exitCode !== 0) {
    return `stage ${last.name} exhausted ${last.attempts} retries (pipeline exit ${exitCode})`;
  }
  return `pipeline exited ${exitCode} (see logs/pipeline.log)`;
}
