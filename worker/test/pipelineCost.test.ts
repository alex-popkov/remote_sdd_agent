import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import * as runJson from '../src/runJson';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Drives the real pipeline/pipeline.sh against a fake `claude` on PATH that
 * writes each agent's primary artifact and prints a `--output-format json`
 * result costing exactly $3 (1M uncached input tokens on claude-sonnet-4-6).
 * Stage accounting goes through the real recordStage.js, compiled once here.
 */

const WORKER_DIR = path.resolve(__dirname, '..');
const PIPELINE = path.resolve(WORKER_DIR, '..', 'pipeline', 'pipeline.sh');

const FAKE_CLAUDE = `#!/usr/bin/env bash
agent=""
while [ $# -gt 0 ]; do
  case "$1" in --agent) agent="$2"; shift 2 ;; *) shift ;; esac
done
sdd=.claude/sdd-tracking
case "$agent" in
  task-researcher) echo r > "$sdd/research/x-research.md" ;;
  task-planner) echo p > "$sdd/plans/x-plan.instructions.md" ;;
  task-executor) echo c > "$sdd/changes/x-changes.md" ;;
  task-verifier) printf 'VERDICT: PASS\\n' > "$sdd/verification/x-verification.md" ;;
  specification-from-artifacts) echo i > .claude/specs/INDEX.md ;;
esac
echo "fake stderr for $agent" >&2
echo '{"type":"result","result":"done","modelUsage":{"claude-sonnet-4-6":{"inputTokens":1000000,"outputTokens":0,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}}'
`;

const TRIGGER: TaskTrigger = {
  triggerId: 'acme__widgets__7__1700000012345',
  source: 'label',
  repo: { owner: 'acme', name: 'widgets' },
  issue: { number: 7, title: 'Do it', body: 'body', url: 'https://x', author: 'alice' },
  actor: 'alice',
  raw: { event: 'issues', action: 'labeled' },
};

let recorderJs: string;
let binDir: string;

beforeAll(() => {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'worker-build-'));
  execFileSync(path.join(WORKER_DIR, 'node_modules', '.bin', 'tsc'), ['-p', WORKER_DIR, '--outDir', outDir]);
  recorderJs = path.join(outDir, 'worker', 'src', 'recordStage.js');

  binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-claude-'));
  fs.writeFileSync(path.join(binDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
}, 60_000);

function runPipeline(runDir: string, maxCostUsd: string) {
  return spawnSync('bash', [PIPELINE], {
    cwd: path.join(runDir, 'repo'),
    encoding: 'utf-8',
    env: {
      ...process.env,
      PATH: `${binDir}:${process.env.PATH}`,
      RUN_DIR: runDir,
      RECORD_STAGE_JS: recorderJs,
      MAX_COST_USD: maxCostUsd,
      MAX_STAGE_RETRIES: '1',
      TRIGGER_ID: TRIGGER.triggerId,
      TRIGGER_SOURCE: TRIGGER.source,
      ISSUE_NUMBER: String(TRIGGER.issue.number),
      ISSUE_TITLE: TRIGGER.issue.title,
      ISSUE_BODY: TRIGGER.issue.body,
    },
  });
}

describe('pipeline.sh cost accounting + kill-switch', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-run-'));
    fs.mkdirSync(path.join(runDir, 'repo'));
    fs.mkdirSync(path.join(runDir, 'artifacts'));
    runJson.init(runDir, TRIGGER, '2026-09-28T00:00:00.000Z');
  });

  it('exits 42 once the run total reaches MAX_COST_USD and runs no further stages', () => {
    const res = runPipeline(runDir, '0.01');
    expect(res.status).toBe(42);
    expect(res.stdout).toContain('COST CEILING');

    const meta = runJson.read(runDir);
    expect(meta.stages.map(s => s.name)).toEqual(['task-researcher']);
    expect(meta.totalCostUsd).toBe(3);
    expect(fs.existsSync(path.join(runDir, 'logs', 'task-planner.log'))).toBe(false);
  });

  it('records every stage with tokens, cost, duration and exit code on a green run', () => {
    const res = runPipeline(runDir, '100');
    expect(res.status).toBe(0);

    const meta = runJson.read(runDir);
    expect(meta.stages.map(s => s.name)).toEqual([
      'task-researcher',
      'task-planner',
      'plan-challenge',
      'task-executor',
      'task-verifier',
      'specification',
    ]);
    for (const s of meta.stages) {
      expect(s).toMatchObject({
        attempts: 1,
        inputTokens: 1_000_000,
        outputTokens: 0,
        costUsd: 3,
        exitCode: 0,
        models: ['claude-sonnet-4-6'],
      });
      expect(s.durationMs).toBeGreaterThanOrEqual(0);
    }
    expect(meta.totalCostUsd).toBe(18);
    // Stage logs keep both the CLI's stderr and its JSON result.
    const log = fs.readFileSync(path.join(runDir, 'logs', 'task-researcher.log'), 'utf-8');
    expect(log).toContain('fake stderr for task-researcher');
    expect(log).toContain('"result":"done"');
  });

  it('records a hard-failed stage with a non-zero exit code', () => {
    // A claude that exits cleanly but never writes the researcher artifact.
    fs.writeFileSync(path.join(binDir, 'claude'), '#!/usr/bin/env bash\necho "{}"\n', { mode: 0o755 });
    try {
      const res = runPipeline(runDir, '100');
      expect(res.status).toBe(1);
      const meta = runJson.read(runDir);
      expect(meta.stages).toHaveLength(1);
      expect(meta.stages[0]).toMatchObject({ name: 'task-researcher', attempts: 1, exitCode: 1, costUsd: 0 });
    } finally {
      fs.writeFileSync(path.join(binDir, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
    }
  });
});
