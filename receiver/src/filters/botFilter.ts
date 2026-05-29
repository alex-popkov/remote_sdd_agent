// Anti-loop: GitHub App actions arrive with sender.login ending in "[bot]".
// Without this filter the agent retriggers itself on its own PRs/comments.

export interface SenderShape {
  sender?: { login?: string };
}

/** Returns true when the sender is a bot (caller should drop the event). */
export function isBotSender(payload: SenderShape): boolean {
  const login = payload.sender?.login ?? '';
  return login.endsWith('[bot]');
}