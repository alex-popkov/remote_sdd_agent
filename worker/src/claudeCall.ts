import path from 'node:path';
import { run } from './exec';
import type { TaskTrigger } from '../../shared/src/types';

/**
 * M4 "naive" Claude call: one fresh `claude -p` session pointed at the cloned
 * repo, asked to fix the issue directly. No SDD pipeline yet (that's M5).
 *
 * `--permission-mode bypassPermissions` is required: in print mode Claude
 * cannot prompt for approval, so without it every file edit / command is
 * denied and the run always produces an empty diff. The container is the
 * trust boundary here — it only holds the single cloned repo.
 */
export async function naive(
  trigger: TaskTrigger,
  repoDir: string,
  logsDir: string,
  anthropicApiKey: string,
): Promise<number> {
  const prompt = `Fix issue #${trigger.issue.number}: ${trigger.issue.title}\n\n${trigger.issue.body}`;
  const logFile = path.join(logsDir, 'naive.log');

  const { code } = await run(
    'claude',
    ['-p', prompt, '--permission-mode', 'bypassPermissions'],
    {
      cwd: repoDir,
      env: { ...process.env, ANTHROPIC_API_KEY: anthropicApiKey },
      logFile,
    },
  );
  return code;
}