import { runOrThrow } from './exec';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Git operations against the target repo. The agent runs inside the clone,
 * so the GitHub token must never be stored there: the remote URL is plain
 * `https://github.com/<owner>/<name>` and each authenticated git call gets the
 * token through gitAuthEnv() instead.
 */

/**
 * Environment that authenticates git's HTTPS requests to github.com, using
 * config passed through env vars (GIT_CONFIG_COUNT, git >= 2.31) rather than
 * a token-embedded URL. Nothing is written to `.git/config` and the token
 * never appears in argv (visible in `ps`). Same header actions/checkout sets.
 */
export function gitAuthEnv(
  githubToken: string,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const basic = Buffer.from(`x-access-token:${githubToken}`).toString('base64');
  return {
    ...env,
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader',
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

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
  baseBranch?: string,
): Promise<void> {
  const { owner, name } = trigger.repo;
  const url = `https://github.com/${owner}/${name}`;
  // depth=1: the agent works against the branch tip; full history is
  // unnecessary and slower to fetch. With baseBranch set, clone that branch so
  // the agent — and the verifier — work against it instead of the repo default.
  const args = ['clone', '--depth', '1'];
  if (baseBranch) args.push('--branch', baseBranch);
  args.push(url, dest);
  await runOrThrow('git clone', 'git', args, { env: gitAuthEnv(githubToken) });
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