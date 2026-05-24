import fs from 'node:fs';
import path from 'node:path';
import { TaskTrigger } from './normalize';

const QUEUE_DIR = '/queue';
const PENDING_DIR = path.join(QUEUE_DIR, 'pending');

/**
 * File-per-task queue.
 *
 * Each task is written as a separate JSON file in /queue/pending/.
 * Worker picks up files, renames them to /queue/processing/<id>.json
 * (rename is atomic on POSIX), then processes and moves to /queue/done/ or /queue/failed/.
 *
 * Why file-per-task instead of a single JSONL:
 *  - rename() gives us atomic claim — no race between workers
 *  - easy to inspect, retry, or delete individual tasks
 *  - no locking needed
 *
 * Outgrows itself around ~100 tasks/min. Swap for Redis at that point.
 */
export function ensureQueueDirs(): void {
  for (const sub of ['pending', 'processing', 'done', 'failed']) {
    fs.mkdirSync(path.join(QUEUE_DIR, sub), { recursive: true });
  }
}

export function enqueue(trigger: TaskTrigger): string {
  const filename = `${trigger.triggerId}.json`;
  const tmpPath = path.join(QUEUE_DIR, `.tmp-${filename}`);
  const finalPath = path.join(PENDING_DIR, filename);

  // Write to temp file first, then atomically rename. This prevents the
  // worker from seeing a half-written file.
  fs.writeFileSync(tmpPath, JSON.stringify(trigger, null, 2), 'utf-8');
  fs.renameSync(tmpPath, finalPath);

  return finalPath;
}
