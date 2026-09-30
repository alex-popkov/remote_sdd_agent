import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { createApp } from '../src/app';
import { openDeliveryStore, DEDUPE_WINDOW_SECONDS } from '../src/dedupe';
import type { ReceiverConfig } from '../src/config';

const SECRET = 'integration-secret';

function freshConfig(): ReceiverConfig {
  return {
    webhookSecret: SECRET,
    allowedRepos: new Set(['acme/widgets']),
    triggerLabel: 'agent:run',
    statusLabel: 'status:ready-for-dev',
    botMention: 'remote-agent',
    port: 0,
    workspaceDir: fs.mkdtempSync(path.join(os.tmpdir(), 'webhook-itest-')),
  };
}

function sign(body: string): string {
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(body).digest('hex');
}

const baseRepo = {
  name: 'widgets',
  owner: { login: 'acme' },
  full_name: 'acme/widgets',
};
const baseIssue = {
  number: 42,
  title: 'Improve thing',
  body: 'do the thing',
  html_url: 'https://github.com/acme/widgets/issues/42',
  user: { login: 'alice' },
};

describe('POST /webhook', () => {
  let config: ReceiverConfig;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    config = freshConfig();
    app = createApp(config);
  });

  it('returns 202 and produces a pending/<triggerId>.json for a valid labeled trigger', async () => {
    const body = JSON.stringify({
      action: 'labeled',
      repository: baseRepo,
      issue: baseIssue,
      label: { name: 'agent:run' },
      sender: { login: 'alice' },
    });
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-GitHub-Delivery', 'd-1')
      .set('X-Hub-Signature-256', sign(body))
      .send(body);

    expect(res.status).toBe(202);
    expect(res.body.triggerId).toMatch(/^acme__widgets__42__\d+$/);

    const pendingDir = path.join(config.workspaceDir, 'queue', 'pending');
    const files = fs.readdirSync(pendingDir).filter(f => f.endsWith('.json') && !f.startsWith('.'));
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${res.body.triggerId}.json`);
  });

  it('returns 401 for an invalid signature', async () => {
    const body = JSON.stringify({ anything: true });
    const res = await request(app)
      .post('/webhook')
      .set('Content-Type', 'application/json')
      .set('X-GitHub-Event', 'issues')
      .set('X-Hub-Signature-256', 'sha256=deadbeef')
      .send(body);
    expect(res.status).toBe(401);

    const pendingDir = path.join(config.workspaceDir, 'queue', 'pending');
    expect(fs.readdirSync(pendingDir).filter(f => f.endsWith('.json'))).toHaveLength(0);
  });

  it('returns 204 for a [bot] sender even with a valid signature', async () => {
    const body = JSON.stringify({
      action: 'labeled',
      repository: baseRepo,
      issue: baseIssue,
      label: { name: 'agent:run' },
      sender: { login: 'remote-agent[bot]' },
    });
    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'issues')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(204);
  });

  it('returns 204 for a non-whitelisted repo', async () => {
    const body = JSON.stringify({
      action: 'labeled',
      repository: { name: 'evil', owner: { login: 'attacker' }, full_name: 'attacker/evil' },
      issue: baseIssue,
      label: { name: 'agent:run' },
      sender: { login: 'alice' },
    });
    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'issues')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(204);
  });

  it('returns 204 for a mapped repo + valid signature but unrelated event', async () => {
    const body = JSON.stringify({
      action: 'opened',
      repository: baseRepo,
      pull_request: { number: 7 },
      sender: { login: 'alice' },
    });
    const res = await request(app)
      .post('/webhook')
      .set('X-GitHub-Event', 'pull_request')
      .set('X-Hub-Signature-256', sign(body))
      .set('Content-Type', 'application/json')
      .send(body);
    expect(res.status).toBe(204);
  });

  describe('replay dedupe (X-GitHub-Delivery)', () => {
    const labeled = JSON.stringify({
      action: 'labeled',
      repository: baseRepo,
      issue: baseIssue,
      label: { name: 'agent:run' },
      sender: { login: 'alice' },
    });
    const deliver = (target: ReturnType<typeof createApp>, deliveryId: string) =>
      request(target)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issues')
        .set('X-GitHub-Delivery', deliveryId)
        .set('X-Hub-Signature-256', sign(labeled))
        .send(labeled);
    const pendingCount = () =>
      fs
        .readdirSync(path.join(config.workspaceDir, 'queue', 'pending'))
        .filter(f => f.endsWith('.json') && !f.startsWith('.')).length;

    it('enqueues the first delivery, answers a replay with duplicate, and forgets it after 24h', async () => {
      let clock = 1_800_000_000;
      const store = openDeliveryStore(path.join(config.workspaceDir, 'state', 'deliveries.db'), () => clock);
      const clocked = createApp(config, store);

      const first = await deliver(clocked, 'abc-123');
      expect(first.status).toBe(202);
      expect(pendingCount()).toBe(1);

      const replay = await deliver(clocked, 'abc-123');
      expect(replay.status).toBe(200);
      expect(replay.body).toEqual({ status: 'duplicate' });
      expect(pendingCount()).toBe(1);

      clock += DEDUPE_WINDOW_SECONDS + 1;
      await new Promise(r => setTimeout(r, 2)); // distinct triggerId (unix ms)
      const later = await deliver(clocked, 'abc-123');
      expect(later.status).toBe(202);
      expect(pendingCount()).toBe(2);
      store.close();
    });

    it('does not record deliveries that fail signature verification', async () => {
      const bad = await request(app)
        .post('/webhook')
        .set('Content-Type', 'application/json')
        .set('X-GitHub-Event', 'issues')
        .set('X-GitHub-Delivery', 'forged')
        .set('X-Hub-Signature-256', 'sha256=deadbeef')
        .send(labeled);
      expect(bad.status).toBe(401);

      const good = await deliver(app, 'forged');
      expect(good.status).toBe(202);
    });
  });

  it('returns 200 ok on /health', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok' });
  });
});