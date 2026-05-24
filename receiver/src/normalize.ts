/**
 * Normalized task trigger — vendor-agnostic shape that the rest of the
 * system works with. When we add Jira / Azure DevOps later, they'll
 * produce the same structure.
 */
export interface TaskTrigger {
  /** Unique ID for this trigger occurrence — used for run directory naming. */
  triggerId: string;
  /** Which kind of event woke us up. Useful for analytics/anti-loop. */
  source: 'label' | 'status' | 'mention';
  /** Where to find the work and where to post the PR. */
  repo: { owner: string; name: string };
  /** Stable identifier of the task in its system of record. */
  issue: {
    number: number;
    title: string;
    body: string;
    url: string;
    author: string;
  };
  /** Who actually triggered this run (may differ from issue author). */
  actor: string;
  /** Raw event for debugging — pipeline shouldn't depend on this. */
  raw: { event: string; action?: string };
}

interface GitHubWebhookPayload {
  action?: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
    labels?: Array<{ name: string }>;
  };
  comment?: {
    body: string;
    user: { login: string };
  };
  label?: { name: string };
  repository?: {
    name: string;
    owner: { login: string };
    full_name: string;
  };
  sender?: { login: string };
}

export interface NormalizeConfig {
  triggerLabel: string;
  botMention: string;
  allowedRepos: string[];
}

/**
 * Returns a TaskTrigger if this event should fire the agent, or null if
 * it should be ignored. We return null (not throw) for "not interesting"
 * because GitHub sends many events we don't care about.
 */
export function normalize(
  eventType: string,
  payload: GitHubWebhookPayload,
  cfg: NormalizeConfig,
): TaskTrigger | null {
  const repo = payload.repository;
  if (!repo) return null;

  // Safety net: reject events from repos we haven't whitelisted.
  if (!cfg.allowedRepos.includes(repo.full_name)) return null;

  // Anti-loop: ignore bot's own actions. Replace 'github-actions[bot]' with
  // your actual app slug + '[bot]'.
  const actor = payload.sender?.login ?? '';
  if (actor.endsWith('[bot]')) return null;

  const issue = payload.issue;
  if (!issue) return null;

  const base = {
    repo: { owner: repo.owner.login, name: repo.name },
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.html_url,
      author: issue.user.login,
    },
    actor,
    triggerId: `${repo.name}-${issue.number}-${Date.now()}`,
  };

  // --- Trigger 1: label added ---
  if (eventType === 'issues' && payload.action === 'labeled') {
    if (payload.label?.name === cfg.triggerLabel) {
      return { ...base, source: 'label', raw: { event: eventType, action: payload.action } };
    }
  }

  // --- Trigger 2: comment mentions the bot ---
  if (eventType === 'issue_comment' && payload.action === 'created') {
    const body = payload.comment?.body ?? '';
    if (body.includes(`@${cfg.botMention}`)) {
      return { ...base, source: 'mention', raw: { event: eventType, action: payload.action } };
    }
  }

  // --- Trigger 3: status change (Projects v2) ---
  // Projects v2 events have a different payload shape (projects_v2_item).
  // For MVP we'll piggyback on a label like "status:ready-for-dev" instead,
  // which is simpler than wiring Projects v2 GraphQL. The label trigger above
  // already covers this case if you adopt that convention.

  return null;
}
