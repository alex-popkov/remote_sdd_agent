import fs from 'node:fs';
import path from 'node:path';
import * as runJson from './runJson';
import type { RunMetadata, TaskTrigger } from '../../shared/src/types';

/**
 * Per-run workspace under `workspace/runs/<triggerId>/`.
 *
 * Layout (worker-runner spec):
 *   repo/       — the cloned target repository
 *   artifacts/  — symlink to repo/.claude/sdd-tracking (agent artifacts)
 *   logs/       — per-stage logs + logs/usage/*.json (claude usage per attempt)
 *   run.json    — RunMetadata, updated to a terminal status before the task
 *                 file leaves processing/
 *
 * run.json itself is owned by runJson.ts (atomic writes, per-stage records
 * appended by the pipeline, exactly-once finalize); these are thin wrappers.
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
  runJson.init(dirs.root, trigger, now);
  return dirs;
}

export function readRunJson(dirs: RunDirs): RunMetadata {
  return runJson.read(dirs.root);
}

/**
 * Set the terminal status (and optional prUrl / failureReason / endedAt) on
 * run.json. Read-modify-write so stage records written by the pipeline
 * survive; a second call on an already-terminal run is a no-op.
 */
export function finalizeRunJson(
  dirs: RunDirs,
  patch: { status: runJson.TerminalStatus } &
    Partial<Pick<RunMetadata, 'endedAt' | 'prUrl' | 'failureReason'>>,
  now: string,
): RunMetadata {
  const { status, ...extra } = patch;
  return runJson.finalize(dirs.root, status, extra, now);
}
