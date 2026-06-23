import { loadConfig } from './config';
import { claimNext, ensureQueueDirs, moveToDone, moveToFailed, type Claim } from './queue';
import { prepareRunWorkspace, finalizeRunJson } from './runWorkspace';
import { cloneRepo, createBranch, hasChanges } from './gitOps';
import { runPipeline, readPipelineOutcome } from './pipeline';
import { createPr } from './prCreate';
import { commentOnIssue } from './notify';

const config = loadConfig();
ensureQueueDirs(config.workspaceDir);

let shuttingDown = false;
process.on('SIGTERM', () => {
  // Spec: finish the current iteration before exiting. We flip a flag and let
  // the main loop check it after the current task completes. If we're idle,
  // the next sleep will exit the loop.
  console.log('[worker] SIGTERM received — will exit after current iteration');
  shuttingDown = true;
});
process.on('SIGINT', () => {
  console.log('[worker] SIGINT received — will exit after current iteration');
  shuttingDown = true;
});

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function now(): string {
  return new Date().toISOString();
}

/**
 * M5 processor: prepare workspace → clone → branch → run the agent SDD
 * pipeline → (non-empty diff) → open PR (draft on a FAIL verdict) + comment
 * back. Finalizes run.json on every exit path and returns the queue
 * disposition; thrown errors are also recorded in run.json before propagating.
 */
async function processTask(claim: Claim): Promise<'done' | 'failed'> {
  const trigger = claim.payload;
  console.log(
    `[worker] processing ${trigger.repo.owner}/${trigger.repo.name}` +
      ` issue #${trigger.issue.number} (source=${trigger.source})`,
  );

  const dirs = prepareRunWorkspace(config.workspaceDir, trigger, now());
  try {
    await cloneRepo(trigger, dirs.repo, config.githubToken, config.baseBranch);
    const branch = await createBranch(dirs.repo, trigger, config.botMention);
    console.log(`[worker] cloned + checked out ${branch}`);

    const code = await runPipeline(dirs, trigger, config);
    if (code !== 0) {
      throw new Error(`pipeline exited ${code} (see logs/pipeline.log)`);
    }

    // Empty-diff guard: nothing changed → fail the run, skip PR creation.
    if (!(await hasChanges(dirs.repo))) {
      console.warn(`[worker] empty diff for ${trigger.triggerId} — skipping PR`);
      finalizeRunJson(dirs, { status: 'failed', failureReason: 'empty-diff' }, now());
      return 'failed';
    }

    // Build the PR body + verdict from the agent artifacts; FAIL → draft PR.
    const { verdict, prBody } = readPipelineOutcome(dirs, trigger);
    const prUrl = await createPr(dirs.repo, trigger, prBody, config.githubToken, {
      draft: verdict === 'FAIL',
      baseBranch: config.baseBranch,
    });
    console.log(`[worker] opened PR ${prUrl} (verdict=${verdict}${verdict === 'FAIL' ? ', draft' : ''})`);
    finalizeRunJson(dirs, { status: 'success', prUrl }, now());

    // Notify is best-effort: the PR already exists, so a comment failure must
    // not flip the run to failed.
    try {
      await commentOnIssue(
        trigger,
        `🤖 Opened a pull request for this issue: ${prUrl}` +
          (verdict === 'FAIL' ? ' (draft — verification did not pass)' : ''),
        config.githubToken,
      );
    } catch (err) {
      console.error(`[worker] issue comment failed (non-fatal):`, err);
    }

    return 'done';
  } catch (err) {
    finalizeRunJson(
      dirs,
      { status: 'failed', failureReason: (err as Error)?.message ?? String(err) },
      now(),
    );
    throw err;
  }
}

async function loop(): Promise<void> {
  console.log(`[worker] polling ${config.workspaceDir}/queue/pending every ${config.pollIntervalMs}ms`);

  while (!shuttingDown) {
    let claim: Claim | null = null;
    try {
      claim = claimNext(config.workspaceDir);
    } catch (err) {
      console.error('[worker] claimNext error:', err);
      await sleep(config.pollIntervalMs);
      continue;
    }

    if (!claim) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    console.log(`[worker] claimed ${claim.triggerId}`);
    let disposition: 'done' | 'failed' = 'failed';
    try {
      disposition = await processTask(claim);
    } catch (err) {
      console.error(`[worker] failed ${claim.triggerId}:`, err);
    }

    try {
      if (disposition === 'done') {
        moveToDone(config.workspaceDir, claim.triggerId);
        console.log(`[worker] done ${claim.triggerId}`);
      } else {
        moveToFailed(config.workspaceDir, claim.triggerId);
        console.log(`[worker] failed ${claim.triggerId}`);
      }
    } catch (moveErr) {
      // If even the move fails, the file is stranded in processing/ and the
      // startup recovery sweep (M8) requeues it after 1h. Don't crash.
      console.error(`[worker] could not move ${claim.triggerId} to ${disposition}:`, moveErr);
    }
  }

  console.log('[worker] exited cleanly');
}

loop().catch(err => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});