import { describe, it, expect } from 'vitest';
import {
  labelTrigger,
  statusTrigger,
  mentionTrigger,
  mapToTrigger,
  type WebhookPayload,
} from '../src/triggerMap';

const CFG = {
  triggerLabel: 'agent:run',
  statusLabel: 'status:ready-for-dev',
  botMention: 'remote-agent',
};

function payload(overrides: Partial<WebhookPayload> = {}): WebhookPayload {
  return {
    action: 'labeled',
    repository: { name: 'widgets', owner: { login: 'acme' }, full_name: 'acme/widgets' },
    issue: {
      number: 42,
      title: 'Improve thing',
      body: 'do the thing',
      html_url: 'https://github.com/acme/widgets/issues/42',
      user: { login: 'alice' },
    },
    sender: { login: 'alice' },
    ...overrides,
  };
}

describe('labelTrigger', () => {
  it('returns a label-source trigger when the trigger label is added', () => {
    const t = labelTrigger('issues', payload({ label: { name: 'agent:run' } }), CFG);
    expect(t).not.toBeNull();
    expect(t!.source).toBe('label');
    expect(t!.repo).toEqual({ owner: 'acme', name: 'widgets' });
    expect(t!.issue.number).toBe(42);
    expect(t!.triggerId).toMatch(/^acme__widgets__42__\d+$/);
  });

  it('returns null for a different label name', () => {
    expect(labelTrigger('issues', payload({ label: { name: 'bug' } }), CFG)).toBeNull();
  });

  it('returns null for non-labeled actions', () => {
    expect(labelTrigger('issues', payload({ action: 'opened', label: { name: 'agent:run' } }), CFG)).toBeNull();
  });

  it('returns null for non-issues events', () => {
    expect(labelTrigger('pull_request', payload({ label: { name: 'agent:run' } }), CFG)).toBeNull();
  });
});

describe('statusTrigger', () => {
  it('returns a status-source trigger when the status label is added', () => {
    const t = statusTrigger('issues', payload({ label: { name: 'status:ready-for-dev' } }), CFG);
    expect(t).not.toBeNull();
    expect(t!.source).toBe('status');
  });

  it('returns null for the regular trigger label (which labelTrigger handles)', () => {
    expect(statusTrigger('issues', payload({ label: { name: 'agent:run' } }), CFG)).toBeNull();
  });
});

describe('mentionTrigger', () => {
  it('returns a mention-source trigger when the comment body mentions @bot', () => {
    const p = payload({
      action: 'created',
      comment: { body: 'hey @remote-agent please look', user: { login: 'alice' } },
    });
    const t = mentionTrigger('issue_comment', p, CFG);
    expect(t).not.toBeNull();
    expect(t!.source).toBe('mention');
  });

  it('returns null when the comment does not mention the bot', () => {
    const p = payload({
      action: 'created',
      comment: { body: 'just a regular comment', user: { login: 'alice' } },
    });
    expect(mentionTrigger('issue_comment', p, CFG)).toBeNull();
  });

  it('returns null for non-issue_comment events', () => {
    expect(mentionTrigger('issues', payload({ comment: { body: '@remote-agent', user: { login: 'a' } } }), CFG)).toBeNull();
  });
});

describe('mapToTrigger', () => {
  it('picks the first matching mapper', () => {
    const t = mapToTrigger('issues', payload({ label: { name: 'agent:run' } }), CFG);
    expect(t?.source).toBe('label');
  });

  it('returns null when no mapper matches', () => {
    expect(mapToTrigger('pull_request', payload({ action: 'opened' }), CFG)).toBeNull();
  });
});