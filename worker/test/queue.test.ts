import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  claimNext,
  ensureQueueDirs,
  moveToDone,
  moveToFailed,
  queueDirs,
} from '../src/queue';
import type { TaskTrigger } from '../../shared/src/types';

function freshWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-queue-'));
  ensureQueueDirs(root);
  return root;
}

function plantPending(workspaceDir: string, triggerId: string): TaskTrigger {
  const payload: TaskTrigger = {
    triggerId,
    source: 'label',
    repo: { owner: 'acme', name: 'widgets' },
    issue: {
      number: 1,
      title: 't',
      body: 'b',
      url: 'https://x',
      author: 'alice',
    },
    actor: 'alice',
    raw: { event: 'issues', action: 'labeled' },
  };
  const file = path.join(queueDirs(workspaceDir).pending, `${triggerId}.json`);
  fs.writeFileSync(file, JSON.stringify(payload), 'utf-8');
  return payload;
}

describe('claimNext', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = freshWorkspace();
  });

  it('returns null when pending is empty', () => {
    expect(claimNext(workspace)).toBeNull();
  });

  it('moves a file from pending/ to processing/ and returns the parsed payload', () => {
    const planted = plantPending(workspace, 'acme__widgets__1__100');
    const claim = claimNext(workspace);
    expect(claim).not.toBeNull();
    expect(claim!.triggerId).toBe(planted.triggerId);
    expect(claim!.payload.source).toBe('label');

    const dirs = queueDirs(workspace);
    expect(fs.existsSync(path.join(dirs.pending, `${planted.triggerId}.json`))).toBe(false);
    expect(fs.existsSync(path.join(dirs.processing, `${planted.triggerId}.json`))).toBe(true);
  });

  it('ignores hidden files (mid-write .json.tmp)', () => {
    const dirs = queueDirs(workspace);
    fs.writeFileSync(path.join(dirs.pending, '.midwrite.json.tmp'), '{}');
    expect(claimNext(workspace)).toBeNull();
  });

  it('ignores non-json files', () => {
    const dirs = queueDirs(workspace);
    fs.writeFileSync(path.join(dirs.pending, 'README.txt'), 'hi');
    expect(claimNext(workspace)).toBeNull();
  });

  it('one of two concurrent claims wins, the other gets null (ENOENT race)', () => {
    // Plant exactly one task. The first call wins; the second must see an
    // empty queue (the file is no longer in pending/) and return null.
    plantPending(workspace, 'acme__widgets__1__100');

    const first = claimNext(workspace);
    const second = claimNext(workspace);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('skips a file that disappears between readdir and rename (simulated)', () => {
    // Plant two files, manually unlink the first to simulate another worker
    // having claimed it between our readdir and our rename. claimNext must
    // continue to the next entry rather than throwing.
    plantPending(workspace, 'acme__widgets__1__100');
    const second = plantPending(workspace, 'acme__widgets__2__200');

    const dirs = queueDirs(workspace);
    const sneakyUnlink = path.join(dirs.pending, 'acme__widgets__1__100.json');

    // Monkey-patch readdir to return both files, then delete the first so the
    // subsequent rename gets ENOENT.
    const realReaddir = fs.readdirSync;
    let called = false;
    (fs as any).readdirSync = (p: string) => {
      const out = realReaddir.call(fs, p);
      if (!called && p === dirs.pending) {
        called = true;
        fs.unlinkSync(sneakyUnlink); // Vanish the first file mid-scan.
      }
      return out;
    };

    try {
      const claim = claimNext(workspace);
      expect(claim).not.toBeNull();
      expect(claim!.triggerId).toBe(second.triggerId);
    } finally {
      (fs as any).readdirSync = realReaddir;
    }
  });
});

describe('moveToDone / moveToFailed', () => {
  let workspace: string;
  beforeEach(() => {
    workspace = freshWorkspace();
  });

  it('moveToDone renames from processing/ to done/', () => {
    plantPending(workspace, 'acme__widgets__1__100');
    claimNext(workspace);

    moveToDone(workspace, 'acme__widgets__1__100');

    const dirs = queueDirs(workspace);
    expect(fs.existsSync(path.join(dirs.processing, 'acme__widgets__1__100.json'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.done, 'acme__widgets__1__100.json'))).toBe(true);
  });

  it('moveToFailed renames from processing/ to failed/', () => {
    plantPending(workspace, 'acme__widgets__1__100');
    claimNext(workspace);

    moveToFailed(workspace, 'acme__widgets__1__100');

    const dirs = queueDirs(workspace);
    expect(fs.existsSync(path.join(dirs.processing, 'acme__widgets__1__100.json'))).toBe(false);
    expect(fs.existsSync(path.join(dirs.failed, 'acme__widgets__1__100.json'))).toBe(true);
  });
});