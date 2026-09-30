import { describe, it, expect } from 'vitest';
import { kebab, branchName } from '../src/gitOps';
import type { TaskTrigger } from '../../shared/src/types';

function trigger(overrides: Partial<TaskTrigger['issue']> & { triggerId?: string } = {}): TaskTrigger {
  const { triggerId, ...issue } = overrides;
  return {
    triggerId: triggerId ?? 'acme__widgets__7__1700000012345',
    source: 'label',
    repo: { owner: 'acme', name: 'widgets' },
    issue: {
      number: 7,
      title: 'Add a thing',
      body: 'b',
      url: 'https://x',
      author: 'alice',
      ...issue,
    },
    actor: 'alice',
    raw: { event: 'issues', action: 'labeled' },
  };
}

describe('kebab', () => {
  it('lowercases, collapses non-alphanumerics, trims dashes', () => {
    expect(kebab('  Fix the Foo/Bar!! ')).toBe('fix-the-foo-bar');
  });

  it('truncates to 40 chars and trims a trailing dash', () => {
    const long = 'a'.repeat(38) + ' bc'; // 'aaa... -bc' → dash lands near the cut
    const out = kebab(long);
    expect(out.length).toBeLessThanOrEqual(40);
    expect(out.endsWith('-')).toBe(false);
  });

  it('returns empty string for all-symbol input', () => {
    expect(kebab('!!!')).toBe('');
  });
});

describe('branchName', () => {
  it('builds agent/<issue>-<slug>-<shortId> with the last 8 triggerId chars', () => {
    expect(branchName(trigger())).toBe('agent/7-add-a-thing-00012345');
  });

  it('omits the slug segment cleanly when the title is all symbols', () => {
    expect(branchName(trigger({ title: '!!!' }))).toBe('agent/7-00012345');
  });

  it('differs across re-triggers of the same issue (unique shortId)', () => {
    const a = branchName(trigger({ triggerId: 'acme__widgets__7__1700000011111' }));
    const b = branchName(trigger({ triggerId: 'acme__widgets__7__1700000022222' }));
    expect(a).not.toBe(b);
  });
});