import type { TaskTrigger } from '../../shared/src/types';

// Shared shape of the subset of the GitHub webhook payload we care about.
// Typed loosely on purpose — GitHub adds fields over time and we only depend
// on the few we explicitly destructure.
export interface WebhookPayload {
  action?: string;
  issue?: {
    number: number;
    title: string;
    body: string | null;
    html_url: string;
    user: { login: string };
  };
  comment?: { body: string; user: { login: string } };
  label?: { name: string };
  repository?: {
    name: string;
    owner: { login: string };
    full_name: string;
  };
  sender?: { login: string };
}

export interface TriggerMapConfig {
  triggerLabel: string;
  statusLabel: string;
  botMention: string;
}

/** Builds a triggerId of the form `<owner>__<repo>__<issue>__<unixMs>`. */
function buildTriggerId(payload: WebhookPayload): string | null {
  const owner = payload.repository?.owner.login;
  const name = payload.repository?.name;
  const issueNumber = payload.issue?.number;
  if (!owner || !name || typeof issueNumber !== 'number') return null;
  return `${owner}__${name}__${issueNumber}__${Date.now()}`;
}

function baseFromPayload(
  payload: WebhookPayload,
  eventType: string,
): Omit<TaskTrigger, 'source'> | null {
  const issue = payload.issue;
  const repo = payload.repository;
  if (!issue || !repo) return null;
  const triggerId = buildTriggerId(payload);
  if (!triggerId) return null;
  return {
    triggerId,
    repo: { owner: repo.owner.login, name: repo.name },
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body ?? '',
      url: issue.html_url,
      author: issue.user.login,
    },
    actor: payload.sender?.login ?? '',
    raw: { event: eventType, action: payload.action },
  };
}

/** Map an issues.labeled event with `label.name === TRIGGER_LABEL` to a label-source trigger. */
export function labelTrigger(
  eventType: string,
  payload: WebhookPayload,
  cfg: TriggerMapConfig,
): TaskTrigger | null {
  if (eventType !== 'issues' || payload.action !== 'labeled') return null;
  if (payload.label?.name !== cfg.triggerLabel) return null;
  const base = baseFromPayload(payload, eventType);
  return base && { ...base, source: 'label' };
}

/** Map an issues.labeled event with the status label to a status-source trigger. */
export function statusTrigger(
  eventType: string,
  payload: WebhookPayload,
  cfg: TriggerMapConfig,
): TaskTrigger | null {
  if (eventType !== 'issues' || payload.action !== 'labeled') return null;
  if (payload.label?.name !== cfg.statusLabel) return null;
  const base = baseFromPayload(payload, eventType);
  return base && { ...base, source: 'status' };
}

/** Map an issue_comment.created event whose body mentions @<BOT_MENTION> to a mention-source trigger. */
export function mentionTrigger(
  eventType: string,
  payload: WebhookPayload,
  cfg: TriggerMapConfig,
): TaskTrigger | null {
  if (eventType !== 'issue_comment' || payload.action !== 'created') return null;
  const body = payload.comment?.body ?? '';
  if (!body.includes(`@${cfg.botMention}`)) return null;
  const base = baseFromPayload(payload, eventType);
  return base && { ...base, source: 'mention' };
}

/** Try each mapping in order; return the first match or null. */
export function mapToTrigger(
  eventType: string,
  payload: WebhookPayload,
  cfg: TriggerMapConfig,
): TaskTrigger | null {
  return (
    labelTrigger(eventType, payload, cfg) ??
    statusTrigger(eventType, payload, cfg) ??
    mentionTrigger(eventType, payload, cfg)
  );
}