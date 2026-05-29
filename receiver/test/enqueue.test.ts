import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { enqueue, ensureQueueDirs, queueDirs } from '../src/enqueue';
import type { TaskTrigger } from '../../shared/src/types';

function freshWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'enqueue-'));
  ensureQueueDirs(root);
  return root;
}

function sampleTrigger(): TaskTrigger {
  return {
    triggerId: 'acme__widgets__42__1717000000000',
    source: 'label',
    repo: { owner: 'acme', name: 'widgets' },
    issue: {
      number: 42,
      title: 'Improve thing',
      body: 'do it',
      url: 'https://github.com/acme/widgets/issues/42',
      author: 'alice',
    },
    actor: 'alice',
    raw: { event: 'issues', action: 'labeled' },
  };
}

describe('enqueue', () => {
  let workspace: string;

  beforeEach(() => {
    workspace = freshWorkspace();
  });

  it('creates all four queue subdirs', () => {
    const dirs = queueDirs(workspace);
    for (const d of Object.values(dirs)) {
      expect(fs.existsSync(d)).toBe(true);
    }
  });

  it('writes a triggerId.json into pending/', () => {
    const trigger = sampleTrigger();
    const id = enqueue(workspace, trigger);
    const finalPath = path.join(queueDirs(workspace).pending, `${id}.json`);
    expect(fs.existsSync(finalPath)).toBe(true);
    const parsed = JSON.parse(fs.readFileSync(finalPath, 'utf-8'));
    expect(parsed.triggerId).toBe(id);
    expect(parsed.source).toBe('label');
  });

  it('does not leave a visible .tmp file after a successful enqueue', () => {
    const trigger = sampleTrigger();
    enqueue(workspace, trigger);
    const files = fs.readdirSync(queueDirs(workspace).pending);
    const tmps = files.filter(f => f.endsWith('.tmp'));
    expect(tmps).toEqual([]);
  });

  it('a non-hidden directory scan ignores any orphan .tmp file', () => {
    // Simulate a crashed enqueue by dropping an orphan tmp into pending/.
    const pending = queueDirs(workspace).pending;
    fs.writeFileSync(path.join(pending, '.orphan.json.tmp'), '{}');

    // A consumer scanning for *.json (non-hidden) should see nothing.
    const visible = fs.readdirSync(pending).filter(f => !f.startsWith('.') && f.endsWith('.json'));
    expect(visible).toEqual([]);
  });
});