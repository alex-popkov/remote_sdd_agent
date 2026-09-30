import { runOrThrow } from './exec';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Post a comment on the source issue via `gh issue comment`. Authenticates
 * from GH_TOKEN. Best-effort: callers decide whether a notify failure should
 * fail the run (it generally shouldn't — the PR already exists).
 */
export async function commentOnIssue(
  trigger: TaskTrigger,
  body: string,
  githubToken: string,
): Promise<void> {
  const { owner, name } = trigger.repo;
  await runOrThrow('gh issue comment', 'gh', [
    'issue',
    'comment',
    String(trigger.issue.number),
    '--repo',
    `${owner}/${name}`,
    '--body',
    body,
  ], { env: { ...process.env, GH_TOKEN: githubToken } });
}