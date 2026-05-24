import fs from 'node:fs';
import path from 'node:path';

const QUEUE = '/queue';
const PENDING = path.join(QUEUE, 'pending');
const PROCESSING = path.join(QUEUE, 'processing');
const DONE = path.join(QUEUE, 'done');
const FAILED = path.join(QUEUE, 'failed');

const POLL_INTERVAL_MS = 5_000;

for (const dir of [PENDING, PROCESSING, DONE, FAILED]) {
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Try to claim one pending task. Returns the claimed file path or null.
 *
 * Atomic claim: rename() is atomic on POSIX, so if two workers race for the
 * same file only one rename succeeds. We're single-worker for now but this
 * lets us scale horizontally later by just running more containers.
 */
function claimNext(): { src: string; trigger: any } | null {
  const files = fs.readdirSync(PENDING).filter(f => f.endsWith('.json')).sort();
  for (const file of files) {
    const from = path.join(PENDING, file);
    const to = path.join(PROCESSING, file);
    try {
      fs.renameSync(from, to);
      const trigger = JSON.parse(fs.readFileSync(to, 'utf-8'));
      return { src: to, trigger };
    } catch (err: any) {
      // ENOENT means another worker grabbed it first; try the next file.
      if (err.code === 'ENOENT') continue;
      throw err;
    }
  }
  return null;
}

async function processTask(trigger: any): Promise<void> {
  // Day-2 work goes here:
  //   1) git clone https://x-access-token:${GITHUB_TOKEN}@github.com/${owner}/${name}
  //      into /runs/${triggerId}/repo
  //   2) Run /pipeline/pipeline.sh with env vars pointing to the run dir
  //   3) gh pr create with artifacts attached
  //   4) Post a comment back to the original issue
  //
  // For day 1 we just log and pretend we did the work.
  console.log(
    `[worker] would run pipeline for ${trigger.repo.owner}/${trigger.repo.name}` +
      ` issue #${trigger.issue.number} (source=${trigger.source})`,
  );
  console.log(`[worker]   title: ${trigger.issue.title}`);
  console.log(`[worker]   actor: ${trigger.actor}`);

  // Simulate some work so logs feel real.
  await new Promise(r => setTimeout(r, 1000));
}

async function loop(): Promise<void> {
  console.log(`[worker] polling ${PENDING} every ${POLL_INTERVAL_MS}ms`);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const claim = claimNext();
      if (!claim) {
        await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
        continue;
      }
      const filename = path.basename(claim.src);
      console.log(`[worker] claimed ${filename}`);
      try {
        await processTask(claim.trigger);
        fs.renameSync(claim.src, path.join(DONE, filename));
        console.log(`[worker] done ${filename}`);
      } catch (err) {
        console.error(`[worker] failed ${filename}:`, err);
        fs.renameSync(claim.src, path.join(FAILED, filename));
      }
    } catch (err) {
      console.error('[worker] loop error:', err);
      await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

loop().catch(err => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
