import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { claimNext, ensureQueueDirs, queueDirs } from '../src/queue';
import { sweepStaleProcessing, STALE_AFTER_MS } from '../src/recovery';
import * as runJson from '../src/runJson';
import type { TaskTrigger } from '../../shared/src/types';

function trigger(triggerId: string): TaskTrigger {
  return {
    triggerId,
    source: 'label',
    repo: { owner: 'acme', name: 'widgets' },
    issue: { number: 1, title: 't', body: 'b', url: 'https://x', author: 'alice' },
    actor: 'alice',
    raw: { event: 'issues', action: 'labeled' },
  };
}

/** Write processing/<id>.json with the given mtime. */
function plantProcessing(workspaceDir: string, triggerId: string, mtimeMs: number): string {
  const file = path.join(queueDirs(workspaceDir).processing, `${triggerId}.json`);
  fs.writeFileSync(file, JSON.stringify(trigger(triggerId)));
  fs.utimesSync(file, new Date(mtimeMs), new Date(mtimeMs));
  return file;
}

describe('sweepStaleProcessing', () => {
  let ws: string;
  const now = Date.parse('2026-09-30T12:00:00Z');

  beforeEach(() => {
    ws = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-recovery-'));
    ensureQueueDirs(ws);
  });

  it('moves a processing file older than 1h back to pending and leaves a fresh one alone', () => {
    plantProcessing(ws, 'acme__widgets__1__1', now - STALE_AFTER_MS - 1000);
    plantProcessing(ws, 'acme__widgets__2__2', now - 5 * 60 * 1000);

    const requeued = sweepStaleProcessing(ws, now);

    const { pending, processing } = queueDirs(ws);
    expect(requeued).toEqual(['acme__widgets__1__1']);
    expect(fs.readdirSync(pending)).toEqual(['acme__widgets__1__1.json']);
    expect(fs.readdirSync(processing)).toEqual(['acme__widgets__2__2.json']);
  });

  it('retires the abandoned run dir so the re-claim starts clean', () => {
    const id = 'acme__widgets__3__3';
    const runDir = path.join(ws, 'runs', id);
    fs.mkdirSync(path.join(runDir, 'repo'), { recursive: true });
    runJson.init(runDir, trigger(id), '2026-09-30T10:00:00.000Z');
    plantProcessing(ws, id, now - 2 * STALE_AFTER_MS);

    sweepStaleProcessing(ws, now);

    const retired = `${runDir}.abandoned-${now}`;
    expect(fs.existsSync(runDir)).toBe(false);
    expect(runJson.read(retired)).toMatchObject({
      status: 'failed',
      failureReason: expect.stringContaining('abandoned'),
    });
  });

  it('ignores hidden files and tolerates a missing processing dir', () => {
    fs.writeFileSync(path.join(queueDirs(ws).processing, '.x.json.tmp'), '{}');
    expect(sweepStaleProcessing(ws, now + 10 * STALE_AFTER_MS)).toEqual([]);
    expect(sweepStaleProcessing(path.join(ws, 'nope'), now)).toEqual([]);
  });

  it('claimNext stamps the claim time, so an old enqueue is not instantly stale', () => {
    const id = 'acme__widgets__4__4';
    const file = path.join(queueDirs(ws).pending, `${id}.json`);
    fs.writeFileSync(file, JSON.stringify(trigger(id)));
    const old = new Date(Date.now() - 3 * STALE_AFTER_MS);
    fs.utimesSync(file, old, old);

    expect(claimNext(ws)?.triggerId).toBe(id);
    expect(sweepStaleProcessing(ws)).toEqual([]);
  });
});
