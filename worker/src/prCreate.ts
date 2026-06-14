import { runOrThrow } from './exec';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * Commit the working-tree changes, push the agent branch, and open a PR with
 * `gh`. Returns the PR URL printed by `gh pr create`.
 *
 * `gh` authenticates from GH_TOKEN in the environment. The push reuses the
 * token-embedded remote set up by cloneRepo, so no extra git auth is needed.
 * `--base` is omitted: `gh` defaults it to the base repo's default branch.
 */
export async function createPr(
  repoDir: string,
  trigger: TaskTrigger,
  body: string,
  githubToken: string,
  options: { draft?: boolean } = {},
): Promise<string> {
  const title = `${trigger.issue.title} (closes #${trigger.issue.number})`;
  const ghEnv = { ...process.env, GH_TOKEN: githubToken };

  // Current branch was set by createBranch(); read it back rather than
  // recomputing so push/PR always target what's actually checked out.
  const { stdout: branchOut } = await runOrThrow('git rev-parse', 'git', [
    'rev-parse',
    '--abbrev-ref',
    'HEAD',
  ], { cwd: repoDir });
  const branch = branchOut.trim();

  await runOrThrow('git add', 'git', ['add', '-A'], { cwd: repoDir });
  await runOrThrow('git commit', 'git', [
    'commit',
    '-m',
    `agent: ${trigger.issue.title} (closes #${trigger.issue.number})`,
  ], { cwd: repoDir });
  await runOrThrow('git push', 'git', ['push', '-u', 'origin', branch], { cwd: repoDir });

  const ghArgs = [
    'pr',
    'create',
    '--title',
    title,
    '--body',
    body,
    '--label',
    'agent:created',
  ];
  if (options.draft) ghArgs.push('--draft');

  const { stdout } = await runOrThrow('gh pr create', 'gh', ghArgs, {
    cwd: repoDir,
    env: ghEnv,
  });

  // gh prints the PR URL as the last non-empty line of stdout.
  const url = stdout
    .trim()
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .pop();
  if (!url) {
    throw new Error('gh pr create succeeded but no PR URL was printed');
  }
  return url;
}