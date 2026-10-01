import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { agentEnv } from '../src/exec';
import { gitAuthEnv } from '../src/gitOps';
import { runPipeline } from '../src/pipeline';
import { runDirs } from '../src/runWorkspace';
import type { WorkerConfig } from '../src/config';
import type { TaskTrigger } from '../../shared/src/types';

const TOKEN = 'ghp_secret_test_token';

describe('agentEnv', () => {
  it('drops worker secrets and keeps everything else', () => {
    const env = agentEnv({
      PATH: '/usr/bin',
      HOME: '/home/x',
      ANTHROPIC_API_KEY: 'sk-ant-x',
      GITHUB_TOKEN: TOKEN,
      GH_TOKEN: TOKEN,
      GITHUB_WEBHOOK_SECRET: 'hmac',
    });
    expect(env).toEqual({ PATH: '/usr/bin', HOME: '/home/x', ANTHROPIC_API_KEY: 'sk-ant-x' });
  });
});

describe('gitAuthEnv', () => {
  it('passes an x-access-token basic auth header that git reads from the environment', () => {
    const env = gitAuthEnv(TOKEN, { PATH: process.env.PATH });
    const header = execFileSync(
      'git',
      ['config', '--get', 'http.https://github.com/.extraheader'],
      { env, encoding: 'utf8' },
    ).trim();
    const [, b64] = header.match(/^AUTHORIZATION: basic (.+)$/)!;
    expect(Buffer.from(b64, 'base64').toString()).toBe(`x-access-token:${TOKEN}`);
  });
});

describe('runPipeline environment', () => {
  let tmp: string;
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('does not expose the GitHub token or webhook secret to the pipeline', async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-iso-'));
    const script = path.join(tmp, 'dump-env.sh');
    fs.writeFileSync(script, 'env > "$RUN_DIR/env.txt"\n');

    const dirs = runDirs(tmp, 'acme__widgets__7__1700000012345');
    for (const d of [dirs.repo, dirs.artifacts, dirs.logs]) fs.mkdirSync(d, { recursive: true });

    const trigger: TaskTrigger = {
      triggerId: 'acme__widgets__7__1700000012345',
      source: 'label',
      repo: { owner: 'acme', name: 'widgets' },
      issue: { number: 7, title: 't', body: 'b', url: 'https://x', author: 'alice' },
      actor: 'alice',
      raw: { event: 'issues', action: 'labeled' },
    };
    const config = {
      githubToken: TOKEN,
      anthropicApiKey: 'sk-ant-x',
      maxCostUsd: 5,
      maxStageRetries: 3,
      maxVerifyRetries: 1,
      enablePlanChallenge: true,
      pipelineScript: script,
    } as WorkerConfig;

    const saved = { ...process.env };
    Object.assign(process.env, { GITHUB_TOKEN: TOKEN, GH_TOKEN: TOKEN, GITHUB_WEBHOOK_SECRET: 'hmac' });
    try {
      expect(await runPipeline(dirs, trigger, config)).toBe(0);
    } finally {
      for (const k of ['GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_WEBHOOK_SECRET']) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }

    const dumped = fs.readFileSync(path.join(dirs.root, 'env.txt'), 'utf8');
    expect(dumped).not.toContain(TOKEN);
    expect(dumped).not.toContain('hmac');
    expect(dumped).toContain('ANTHROPIC_API_KEY=sk-ant-x');
    expect(dumped).toContain('ISSUE_NUMBER=7');
  });
});
