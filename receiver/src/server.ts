import express, { Request, Response } from 'express';
import { verifyGitHubSignature } from './verify-signature';
import { normalize } from './normalize';
import { enqueue, ensureQueueDirs } from './queue';

const PORT = 3000;

// --- Required config (fail fast if missing) ---
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const WEBHOOK_SECRET = requireEnv('GITHUB_WEBHOOK_SECRET');
const TRIGGER_LABEL = process.env.TRIGGER_LABEL ?? 'agent:run';
const BOT_MENTION = process.env.BOT_MENTION ?? 'remote-agent';
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS ?? '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

if (ALLOWED_REPOS.length === 0) {
  console.error('ALLOWED_REPOS must contain at least one "owner/name" entry.');
  process.exit(1);
}

ensureQueueDirs();

const app = express();

// We need the RAW body for HMAC verification, but also parsed JSON for the
// handler. The `verify` callback captures the raw buffer onto req before
// JSON parsing happens.
app.use(
  express.json({
    limit: '1mb',
    verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/webhook', (req: Request & { rawBody?: Buffer }, res: Response) => {
  // 1) Verify signature. Reject before doing any work.
  const sig = req.header('X-Hub-Signature-256');
  if (!req.rawBody || !verifyGitHubSignature(req.rawBody, sig, WEBHOOK_SECRET)) {
    console.warn('Rejected webhook: invalid signature');
    return res.status(401).json({ error: 'invalid signature' });
  }

  const eventType = req.header('X-GitHub-Event') ?? '';
  const deliveryId = req.header('X-GitHub-Delivery') ?? 'unknown';

  // 2) Normalize. Returns null if event isn't a trigger we care about.
  const trigger = normalize(eventType, req.body, {
    triggerLabel: TRIGGER_LABEL,
    botMention: BOT_MENTION,
    allowedRepos: ALLOWED_REPOS,
  });

  if (!trigger) {
    // 204 No Content: signature was valid, we just don't care about this event.
    // GitHub still considers this a successful delivery.
    console.log(`Ignored ${eventType} (${deliveryId})`);
    return res.status(204).end();
  }

  // 3) Enqueue and ack immediately. GitHub gives us ~10s to respond, so we
  // never do real work inside the handler.
  try {
    const queuedAt = enqueue(trigger);
    console.log(
      `Enqueued trigger=${trigger.triggerId} source=${trigger.source} ` +
        `repo=${trigger.repo.owner}/${trigger.repo.name} issue=#${trigger.issue.number}`,
    );
    return res.status(202).json({ accepted: true, triggerId: trigger.triggerId, queued: queuedAt });
  } catch (err) {
    console.error('Enqueue failed:', err);
    return res.status(500).json({ error: 'enqueue failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Receiver listening on :${PORT}`);
  console.log(`Allowed repos: ${ALLOWED_REPOS.join(', ')}`);
  console.log(`Trigger label: "${TRIGGER_LABEL}"`);
  console.log(`Bot mention: "@${BOT_MENTION}"`);
});
