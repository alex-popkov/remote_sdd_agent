import fs from 'node:fs';
import path from 'node:path';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * File-per-task queue with atomic enqueue.
 *
 * Write to `pending/.<triggerId>.json.tmp` first, then `rename()` to
 * `pending/<triggerId>.json`. POSIX rename within the same directory is
 * atomic, so a consumer scanning `pending/` either sees the final filename
 * or nothing — never a partial write. The dotfile prefix keeps the temp
 * file hidden from naive `readdir` filters (consumers ignore dotfiles).
 *
 * `rename()` is also the basis for the worker's claim semantics — see
 * worker/src/queue.ts. Don't change the naming scheme without updating both.
 */
export function queueDirs(workspaceDir: string): {
  pending: string;
  processing: string;
  done: string;
  failed: string;
} {
  const queueRoot = path.join(workspaceDir, 'queue');
  return {
    pending: path.join(queueRoot, 'pending'),
    processing: path.join(queueRoot, 'processing'),
    done: path.join(queueRoot, 'done'),
    failed: path.join(queueRoot, 'failed'),
  };
}

export function ensureQueueDirs(workspaceDir: string): void {
  for (const dir of Object.values(queueDirs(workspaceDir))) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

export function enqueue(workspaceDir: string, trigger: TaskTrigger): string {
  const { pending } = queueDirs(workspaceDir);
  const finalName = `${trigger.triggerId}.json`;
  const tmpName = `.${trigger.triggerId}.json.tmp`;
  const tmpPath = path.join(pending, tmpName);
  const finalPath = path.join(pending, finalName);

  fs.writeFileSync(tmpPath, JSON.stringify(trigger, null, 2), 'utf-8');
  fs.renameSync(tmpPath, finalPath);
  return trigger.triggerId;
}