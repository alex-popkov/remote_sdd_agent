import fs from 'node:fs';
import path from 'node:path';
import type { RunMetadata, StageRecord, TaskTrigger } from '../../shared/src/types';

/**
 * `workspace/runs/<triggerId>/run.json` accessors (run-observability spec).
 *
 * Every write goes to a sibling tmp file and is `rename()`d into place, so a
 * concurrent reader (pipeline.sh's kill-switch, an operator's `cat`) never
 * sees a half-written file. Writers are sequential by construction: the worker
 * initializes, pipeline.sh appends stages (via recordStage.ts) while the worker
 * waits on it, and the worker finalizes after the pipeline has exited.
 */

export function runJsonPath(runDir: string): string {
  return path.join(runDir, 'run.json');
}

export function read(runDir: string): RunMetadata {
  return JSON.parse(fs.readFileSync(runJsonPath(runDir), 'utf-8')) as RunMetadata;
}

function write(runDir: string, metadata: RunMetadata): void {
  const file = runJsonPath(runDir);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

export function init(runDir: string, trigger: TaskTrigger, now: string): RunMetadata {
  const initial: RunMetadata = {
    triggerId: trigger.triggerId,
    startedAt: now,
    status: 'running',
    stages: [],
    totalCostUsd: 0,
  };
  write(runDir, initial);
  return initial;
}

/** Append a stage record and recompute totalCostUsd as the sum of stage costs. */
export function appendStage(runDir: string, stage: StageRecord): RunMetadata {
  const current = read(runDir);
  const stages = [...current.stages, stage];
  const next: RunMetadata = {
    ...current,
    stages,
    totalCostUsd: roundUsd(stages.reduce((sum, s) => sum + s.costUsd, 0)),
  };
  write(runDir, next);
  return next;
}

export type TerminalStatus = Exclude<RunMetadata['status'], 'running'>;

/**
 * Set the terminal status + endedAt (and optional prUrl / failureReason).
 * Terminal state is written exactly once: if run.json is already terminal the
 * call is a no-op and returns the existing metadata.
 */
export function finalize(
  runDir: string,
  status: TerminalStatus,
  extra: Partial<Pick<RunMetadata, 'failureReason' | 'prUrl' | 'endedAt'>> = {},
  now: string = new Date().toISOString(),
): RunMetadata {
  const current = read(runDir);
  if (current.status !== 'running') {
    console.warn(`[runJson] ${current.triggerId} already finalized as ${current.status}; ignoring ${status}`);
    return current;
  }
  const next: RunMetadata = { ...current, ...extra, status, endedAt: extra.endedAt ?? now };
  write(runDir, next);
  return next;
}

/** Round to micro-dollars so repeated float sums stay readable in run.json. */
export function roundUsd(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
