import fs from 'node:fs';
import path from 'node:path';
import { queueDirs } from './queue';
import * as runJson from './runJson';

/** A processing/ file untouched for this long belongs to a dead worker. */
export const STALE_AFTER_MS = 60 * 60 * 1000;

/**
 * Startup recovery (task-queue spec, "Idle-task recovery"): move every
 * `processing/*.json` whose mtime is older than `staleAfterMs` back to
 * `pending/` so a fresh attempt can claim it. Fresh files are left alone —
 * they may belong to another live worker. claimNext() touches the file on
 * claim, so mtime is the claim time, not the enqueue time.
 *
 * The abandoned attempt's run dir is finalized as failed and renamed to
 * `runs/<triggerId>.abandoned-<unixMs>`: it stays for postmortem, and the
 * re-claim gets a clean `runs/<triggerId>/` to clone into.
 *
 * Returns the requeued triggerIds. Must run before the main loop.
 */
export function sweepStaleProcessing(
  workspaceDir: string,
  nowMs: number = Date.now(),
  staleAfterMs: number = STALE_AFTER_MS,
): string[] {
  const { pending, processing } = queueDirs(workspaceDir);
  const requeued: string[] = [];

  let entries: string[];
  try {
    entries = fs.readdirSync(processing);
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return requeued;
    throw err;
  }

  for (const filename of entries.filter(f => !f.startsWith('.') && f.endsWith('.json')).sort()) {
    const from = path.join(processing, filename);
    let mtimeMs: number;
    try {
      mtimeMs = fs.statSync(from).mtimeMs;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    if (nowMs - mtimeMs < staleAfterMs) continue;

    const triggerId = filename.slice(0, -'.json'.length);
    retireRunDir(workspaceDir, triggerId, nowMs);
    try {
      fs.renameSync(from, path.join(pending, filename));
    } catch (err: unknown) {
      // Another worker finished or recovered it first.
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    requeued.push(triggerId);
  }
  return requeued;
}

function retireRunDir(workspaceDir: string, triggerId: string, nowMs: number): void {
  const runDir = path.join(workspaceDir, 'runs', triggerId);
  if (!fs.existsSync(runDir)) return;
  try {
    runJson.finalize(runDir, 'failed', { failureReason: 'abandoned: worker died; requeued by startup recovery' },
      new Date(nowMs).toISOString());
  } catch (err) {
    console.warn(`[recovery] could not finalize run.json for ${triggerId}:`, err);
  }
  fs.renameSync(runDir, `${runDir}.abandoned-${nowMs}`);
}
