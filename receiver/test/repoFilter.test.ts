import { describe, it, expect } from 'vitest';
import { isAllowedRepo } from '../src/filters/repoFilter';

describe('isAllowedRepo', () => {
  const allowed = new Set(['acme/widgets', 'foo/bar']);

  it('returns true for a whitelisted full_name', () => {
    expect(isAllowedRepo({ repository: { full_name: 'acme/widgets' } }, allowed)).toBe(true);
  });

  it('returns false for a non-whitelisted full_name', () => {
    expect(isAllowedRepo({ repository: { full_name: 'evil/repo' } }, allowed)).toBe(false);
  });

  it('returns false when repository.full_name is absent', () => {
    expect(isAllowedRepo({}, allowed)).toBe(false);
    expect(isAllowedRepo({ repository: {} }, allowed)).toBe(false);
  });

  it('is case-sensitive (GitHub repo names are case-insensitive but webhooks return canonical case)', () => {
    expect(isAllowedRepo({ repository: { full_name: 'ACME/widgets' } }, allowed)).toBe(false);
  });
});