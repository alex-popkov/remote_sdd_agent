import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { costUsd, rateFor, FALLBACK_RATE } from '../src/pricing';
import { parseClaudeResult, buildStageRecord } from '../src/recordStage';
import * as runJson from '../src/runJson';
import { costAbortReason, costAbortComment, pipelineFailureReason } from '../src/costReport';
import type { StageRecord, TaskTrigger } from '../../shared/src/types';

const TRIGGER: TaskTrigger = {
  triggerId: 'acme__widgets__7__1700000012345',
  source: 'label',
  repo: { owner: 'acme', name: 'widgets' },
  issue: { number: 7, title: 't', body: 'b', url: 'https://x', author: 'alice' },
  actor: 'alice',
  raw: { event: 'issues', action: 'labeled' },
};

function stage(name: string, cost: number, exitCode = 0): StageRecord {
  return {
    name,
    attempts: 1,
    durationMs: 1000,
    inputTokens: 100,
    outputTokens: 10,
    costUsd: cost,
    exitCode,
  };
}

describe('pricing', () => {
  it('computes input*rate + output*rate (spec scenario: 1000 in / 500 out at $3/$15)', () => {
    const cost = costUsd({
      model: 'claude-sonnet-4-6',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
    expect(cost).toBeCloseTo(0.0105, 10);
  });

  it('matches dated / suffixed model ids by longest prefix', () => {
    expect(rateFor('claude-haiku-4-5-20251001').known).toBe(true);
    expect(rateFor('claude-opus-5-5[1m]').rate.inputUsdPerMtok).toBe(4); // not claude-opus-5
    expect(rateFor('claude-opus-5').rate.inputUsdPerMtok).toBe(5);
  });

  it('prices unknown models at the highest rate so the kill-switch never under-counts', () => {
    expect(rateFor('some-future-model')).toEqual({ rate: FALLBACK_RATE, known: false });
  });
});

describe('parseClaudeResult / buildStageRecord', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures', 'claude-result.json'), 'utf-8');

  it('reads per-model usage from real `claude -p --output-format json` output', () => {
    const usages = parseClaudeResult(fixture);
    expect(usages).toEqual([
      {
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 10,
        outputTokens: 36,
        cacheReadTokens: 12306,
        cacheWriteTokens: 8383,
      },
    ]);
    // Our local price agrees with what the CLI itself reported for the call.
    const reported = JSON.parse(fixture).total_cost_usd as number;
    expect(costUsd(usages[0])).toBeCloseTo(reported, 6);
  });

  it('yields no usage for empty or non-JSON output (crashed attempt)', () => {
    expect(parseClaudeResult('')).toEqual([]);
    expect(parseClaudeResult('Error: something broke')).toEqual([]);
  });

  it('sums tokens and cost across retry attempts', () => {
    const usages = [...parseClaudeResult(fixture), ...parseClaudeResult(fixture)];
    const rec = buildStageRecord('task-planner', 2, 0, 75_000, usages);
    expect(rec).toMatchObject({
      name: 'task-planner',
      attempts: 2,
      durationMs: 75_000,
      inputTokens: 2 * (10 + 12306 + 8383),
      outputTokens: 72,
      cacheReadTokens: 2 * 12306,
      cacheWriteTokens: 2 * 8383,
      models: ['claude-haiku-4-5-20251001'],
      exitCode: 0,
    });
    expect(rec.costUsd).toBeCloseTo(2 * 0.0181866, 6);
  });
});

describe('runJson', () => {
  let runDir: string;
  beforeEach(() => {
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runjson-'));
    runJson.init(runDir, TRIGGER, '2026-09-28T00:00:00.000Z');
  });

  it('appendStage keeps totalCostUsd equal to the sum of stage costs', () => {
    runJson.appendStage(runDir, stage('a', 0.01));
    runJson.appendStage(runDir, stage('b', 0.04));
    const meta = runJson.appendStage(runDir, stage('c', 0.02));
    expect(meta.stages.map(s => s.name)).toEqual(['a', 'b', 'c']);
    expect(meta.totalCostUsd).toBe(0.07);
    expect(runJson.read(runDir).totalCostUsd).toBe(0.07);
  });

  it('leaves no tmp files behind', () => {
    runJson.appendStage(runDir, stage('a', 0.01));
    expect(fs.readdirSync(runDir)).toEqual(['run.json']);
  });

  it('finalizes exactly once', () => {
    const first = runJson.finalize(runDir, 'aborted-cost', { failureReason: 'cost' }, 't1');
    expect(first).toMatchObject({ status: 'aborted-cost', endedAt: 't1' });
    const second = runJson.finalize(runDir, 'success', {}, 't2');
    expect(second).toMatchObject({ status: 'aborted-cost', endedAt: 't1' });
    expect(runJson.read(runDir).status).toBe('aborted-cost');
  });
});

describe('costReport', () => {
  const meta = {
    triggerId: TRIGGER.triggerId,
    startedAt: 's',
    status: 'running' as const,
    stages: [stage('task-researcher', 1.2), stage('task-planner', 3.9)],
    totalCostUsd: 5.1,
  };

  it('cost-abort reason names the cause and the dollar amounts', () => {
    const reason = costAbortReason(meta, 5);
    expect(reason).toContain('cost');
    expect(reason).toContain('$5.10');
    expect(reason).toContain('$5.00');
    expect(reason).toContain('task-planner $3.90');
  });

  it('cost-abort comment carries a per-stage breakdown and total', () => {
    const body = costAbortComment(meta, 5);
    expect(body).toContain('| task-researcher | 1 | 100 | 10 | $1.20 |');
    expect(body).toContain('**$5.10**');
    expect(body).toContain(TRIGGER.triggerId);
  });

  it('hard-failure reason names the failing stage and retries', () => {
    const failed = { ...meta, stages: [stage('task-researcher', 1), { ...stage('task-executor', 1, 1), attempts: 3 }] };
    expect(pipelineFailureReason(failed, 1)).toBe('stage task-executor exhausted 3 retries (pipeline exit 1)');
    expect(pipelineFailureReason(null, 7)).toContain('pipeline exited 7');
  });
});
