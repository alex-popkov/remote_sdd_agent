import { runOrThrow } from './exec';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Git operations against the target repo. The clone URL embeds the GitHub
 * token; it is passed to `git` via an argv array (no shell) and is never
 * logged — see the note in exec.ts. Once cloned, the token lives in the
 * repo's `.git/config` remote, which is fine inside the ephemeral run dir
 * and lets `git push` reuse the same credential.
 */

/** kebab-case a string and truncate to `max` chars (default 40). */
export function kebab(input: string, max = 40): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug.slice(0, max).replace(/-+$/g, '');
}

/** `agent/<issue>-<slug>-<shortTriggerId>`; shortTriggerId = last 8 chars. */
export function branchName(trigger: TaskTrigger): string {
  const slug = kebab(trigger.issue.title);
  const shortId = trigger.triggerId.slice(-8);
  const middle = slug ? `${slug}-` : '';
  return `agent/${trigger.issue.number}-${middle}${shortId}`;
}

export async function cloneRepo(
  trigger: TaskTrigger,
  dest: string,
  githubToken: string,
): Promise<void> {
  const { owner, name } = trigger.repo;
  const url = `https://x-access-token:${githubToken}@github.com/${owner}/${name}`;
  // depth=1: the agent works against the default branch tip; full history is
  // unnecessary and slower to fetch.
  await runOrThrow('git clone', 'git', ['clone', '--depth', '1', url, dest]);
}

/**
 * Create and check out the agent branch, and set a committer identity so the
 * later `git commit` doesn't fail in the container's empty git config.
 */
export async function createBranch(
  repoDir: string,
  trigger: TaskTrigger,
  botMention: string,
): Promise<string> {
  const branch = branchName(trigger);
  await runOrThrow('git checkout -b', 'git', ['checkout', '-b', branch], { cwd: repoDir });
  await runOrThrow('git config user.name', 'git', [
    'config',
    'user.name',
    botMention,
  ], { cwd: repoDir });
  await runOrThrow('git config user.email', 'git', [
    'config',
    'user.email',
    `${botMention}@users.noreply.github.com`,
  ], { cwd: repoDir });
  return branch;
}

/** True if the working tree has staged or unstaged changes (incl. untracked). */
export async function hasChanges(repoDir: string): Promise<boolean> {
  const { stdout } = await runOrThrow('git status', 'git', [
    'status',
    '--porcelain',
  ], { cwd: repoDir });
  return stdout.trim().length > 0;
}