import fs from 'node:fs';
import path from 'node:path';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Filesystem queue accessors used by the worker.
 *
 * Claim semantics are based entirely on `rename()` being atomic within a
 * filesystem on POSIX: if two workers try to claim the same file, exactly
 * one rename succeeds. The loser sees ENOENT and moves on.
 */

export function queueDirs(workspaceDir: string): {
  pending: string;
  processing: string;
  done: string;
  failed: string;
} {
  const root = path.join(workspaceDir, 'queue');
  return {
    pending: path.join(root, 'pending'),
    processing: path.join(root, 'processing'),
    done: path.join(root, 'done'),
    failed: path.join(root, 'failed'),
  };
}

export function ensureQueueDirs(workspaceDir: string): void {
  for (const dir of Object.values(queueDirs(workspaceDir))) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export interface Claim {
  triggerId: string;
  payload: TaskTrigger;
}

/**
 * Try to claim one pending task. Returns null when the queue is empty OR
 * when every pending file is being raced for and lost to another worker.
 *
 * ENOENT on rename means another claimant won — we skip that file and
 * continue, never propagate the error.
 */
export function claimNext(workspaceDir: string): Claim | null {
  const { pending, processing } = queueDirs(workspaceDir);

  let entries: string[];
  try {
    entries = fs.readdirSync(pending);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }

  // Spec: scan only non-hidden *.json files. Hidden .<id>.json.tmp files
  // are mid-write enqueues we must ignore. Sort so claim order is
  // deterministic across workers.
  const candidates =
      entries.filter(f => !f.startsWith('.') && f.endsWith('.json')).sort();

  for (const filename of candidates) {
    const from = path.join(pending, filename);
    const to = path.join(processing, filename);
    try {
      fs.renameSync(from, to);
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    // rename() keeps the enqueue-time mtime; stamp the claim time so startup
    // recovery (recovery.ts) measures staleness from the claim.
    const claimedAt = new Date();
    fs.utimesSync(to, claimedAt, claimedAt);
    const raw = fs.readFileSync(to, 'utf-8');
    const payload = JSON.parse(raw) as TaskTrigger;
    return { triggerId: payload.triggerId, payload };
  }

  return null;
}

export function moveToDone(workspaceDir: string, triggerId: string): void {
  moveTerminal(workspaceDir, triggerId, 'done');
}

export function moveToFailed(workspaceDir: string, triggerId: string): void {
  moveTerminal(workspaceDir, triggerId, 'failed');
}

function moveTerminal(
  workspaceDir: string,
  triggerId: string,
  to: 'done' | 'failed',
): void {
  const dirs = queueDirs(workspaceDir);
  const from = path.join(dirs.processing, `${triggerId}.json`);
  const dest = path.join(dirs[to], `${triggerId}.json`);
  fs.renameSync(from, dest);
}