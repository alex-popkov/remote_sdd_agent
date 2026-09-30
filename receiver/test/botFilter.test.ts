import { describe, it, expect } from 'vitest';
import { isBotSender } from '../src/filters/botFilter';

describe('isBotSender', () => {
  it('returns true when the sender login ends with [bot]', () => {
    expect(isBotSender({ sender: { login: 'remote-agent[bot]' } })).toBe(true);
  });

  it('returns false for a human sender', () => {
    expect(isBotSender({ sender: { login: 'alice' } })).toBe(false);
  });

  it('returns false for a sender that merely contains "bot"', () => {
    expect(isBotSender({ sender: { login: 'robot-handler' } })).toBe(false);
  });

  it('returns false when sender is absent', () => {
    expect(isBotSender({})).toBe(false);
  });
});