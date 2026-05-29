import { loadConfig } from './config';
import { claimNext, ensureQueueDirs, moveToDone, moveToFailed, type Claim } from './queue';

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

/**
 * M3 stub processor: claim → log → succeed. M4 replaces this with the real
 * clone + Claude + PR flow. Keep this minimal so the queue plumbing is
 * provably correct before adding moving parts.
 */
async function processTask(claim: Claim): Promise<void> {
  const { payload } = claim;
  console.log(
    `[worker] would run pipeline for ${payload.repo.owner}/${payload.repo.name}` +
      ` issue #${payload.issue.number} (source=${payload.source})`,
  );
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
    try {
      await processTask(claim);
      moveToDone(config.workspaceDir, claim.triggerId);
      console.log(`[worker] done ${claim.triggerId}`);
    } catch (err) {
      console.error(`[worker] failed ${claim.triggerId}:`, err);
      try {
        moveToFailed(config.workspaceDir, claim.triggerId);
      } catch (moveErr) {
        // If even the move-to-failed fails, log and continue — the file is
        // stranded in processing/ and the startup recovery sweep (M8) will
        // requeue it after 1h. Don't crash the worker for a bookkeeping bug.
        console.error(`[worker] could not move to failed:`, moveErr);
      }
    }
  }

  console.log('[worker] exited cleanly');
}

loop().catch(err => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});