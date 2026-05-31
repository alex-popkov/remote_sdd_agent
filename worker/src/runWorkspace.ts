import fs from 'node:fs';
import path from 'node:path';
import type { RunMetadata, TaskTrigger } from '../../shared/src/types';

/**
 * Per-run workspace under `workspace/runs/<triggerId>/`.
 *
 * Layout (worker-runner spec):
 *   repo/       — the cloned target repository
 *   artifacts/  — pipeline stage outputs (context.json, spec.md, ...) [M5+]
 *   logs/       — per-stage / naive-call logs
 *   run.json    — RunMetadata, updated to a terminal status before the task
 *                 file leaves processing/
 *
 * run.json is written atomically (tmp + rename) so a concurrent reader never
 * sees a half-written file. Richer per-stage accounting lands in M7
 * (worker/src/runJson.ts); M4 only needs init + terminal finalize.
 */
export interface RunDirs {
  root: string;
  repo: string;
  artifacts: string;
  logs: string;
  runJson: string;
}

export function runDirs(workspaceDir: string, triggerId: string): RunDirs {
  const root = path.join(workspaceDir, 'runs', triggerId);
  return {
    root,
    repo: path.join(root, 'repo'),
    artifacts: path.join(root, 'artifacts'),
    logs: path.join(root, 'logs'),
    runJson: path.join(root, 'run.json'),
  };
}

/** Create the run directory tree and write run.json with status "running". */
export function prepareRunWorkspace(
  workspaceDir: string,
  trigger: TaskTrigger,
  now: string,
): RunDirs {
  const dirs = runDirs(workspaceDir, trigger.triggerId);
  for (const dir of [dirs.repo, dirs.artifacts, dirs.logs]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const initial: RunMetadata = {
    triggerId: trigger.triggerId,
    startedAt: now,
    status: 'running',
    stages: [],
    totalCostUsd: 0,
  };
  writeRunJson(dirs, initial);
  return dirs;
}

export function readRunJson(dirs: RunDirs): RunMetadata {
  return JSON.parse(fs.readFileSync(dirs.runJson, 'utf-8')) as RunMetadata;
}

export function writeRunJson(dirs: RunDirs, metadata: RunMetadata): void {
  const tmp = `${dirs.runJson}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2), 'utf-8');
  fs.renameSync(tmp, dirs.runJson);
}

/**
 * Set the terminal status (and optional prUrl / failureReason / endedAt) on
 * run.json. Read-modify-write so any fields written earlier survive.
 */
export function finalizeRunJson(
  dirs: RunDirs,
  patch: Pick<RunMetadata, 'status'> &
    Partial<Pick<RunMetadata, 'endedAt' | 'prUrl' | 'failureReason'>>,
  now: string,
): RunMetadata {
  const current = readRunJson(dirs);
  const next: RunMetadata = {
    ...current,
    ...patch,
    endedAt: patch.endedAt ?? now,
  };
  writeRunJson(dirs, next);
  return next;
}