import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  prepareRunWorkspace,
  finalizeRunJson,
  readRunJson,
  runDirs,
} from '../src/runWorkspace';
import type { TaskTrigger } from '../../shared/src/types';

const TRIGGER: TaskTrigger = {
  triggerId: 'acme__widgets__7__1700000012345',
  source: 'label',
  repo: { owner: 'acme', name: 'widgets' },
  issue: { number: 7, title: 't', body: 'b', url: 'https://x', author: 'alice' },
  actor: 'alice',
  raw: { event: 'issues', action: 'labeled' },
};

describe('prepareRunWorkspace', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runs-'));
  });

  it('creates repo/artifacts/logs and an initial running run.json', () => {
    const dirs = prepareRunWorkspace(workspace, TRIGGER, '2026-05-31T00:00:00.000Z');

    expect(fs.existsSync(dirs.repo)).toBe(true);
    expect(fs.existsSync(dirs.artifacts)).toBe(true);
    expect(fs.existsSync(dirs.logs)).toBe(true);

    const meta = readRunJson(dirs);
    expect(meta.status).toBe('running');
    expect(meta.startedAt).toBe('2026-05-31T00:00:00.000Z');
    expect(meta.stages).toEqual([]);
    expect(meta.totalCostUsd).toBe(0);
    expect(meta.triggerId).toBe(TRIGGER.triggerId);
  });

  it('runDirs roots the run under workspace/runs/<triggerId>', () => {
    const dirs = runDirs(workspace, TRIGGER.triggerId);
    expect(dirs.root).toBe(path.join(workspace, 'runs', TRIGGER.triggerId));
  });
});

describe('finalizeRunJson', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-runs-'));
  });

  it('records success + prUrl + endedAt, preserving startedAt', () => {
    const dirs = prepareRunWorkspace(workspace, TRIGGER, '2026-05-31T00:00:00.000Z');
    const out = finalizeRunJson(
      dirs,
      { status: 'success', prUrl: 'https://github.com/acme/widgets/pull/9' },
      '2026-05-31T00:05:00.000Z',
    );
    expect(out.status).toBe('success');
    expect(out.prUrl).toBe('https://github.com/acme/widgets/pull/9');
    expect(out.endedAt).toBe('2026-05-31T00:05:00.000Z');
    expect(out.startedAt).toBe('2026-05-31T00:00:00.000Z');

    // Persisted, not just returned.
    expect(readRunJson(dirs).status).toBe('success');
  });

  it('records the empty-diff failure reason', () => {
    const dirs = prepareRunWorkspace(workspace, TRIGGER, '2026-05-31T00:00:00.000Z');
    const out = finalizeRunJson(dirs, { status: 'failed', failureReason: 'empty-diff' }, 'now');
    expect(out.status).toBe('failed');
    expect(out.failureReason).toBe('empty-diff');
  });
});