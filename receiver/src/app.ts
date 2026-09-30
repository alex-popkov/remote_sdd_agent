import path from 'node:path';
import express, { Request, Response } from 'express';
import { verifySignature } from './verifySignature';
import { isBotSender } from './filters/botFilter';
import { isAllowedRepo } from './filters/repoFilter';
import { mapToTrigger, type WebhookPayload } from './triggerMap';
import { enqueue, ensureQueueDirs } from './enqueue';
import { openDeliveryStore, type DeliveryStore } from './dedupe';
import type { ReceiverConfig } from './config';

/**
 * Build an Express app from an explicit config so tests can mount it without
 * touching process.env or binding a port. server.ts is the production entry
 * point that calls loadConfig() and app.listen().
 */
export function createApp(
  config: ReceiverConfig,
  deliveries: DeliveryStore = openDeliveryStore(path.join(config.workspaceDir, 'state', 'deliveries.db')),
) {
  ensureQueueDirs(config.workspaceDir);

  const app = express();

  // The HMAC must be computed over the raw byte stream. Express's `verify`
  // callback runs before JSON parsing, so this is the only place we can
  // capture the raw body without breaking the parser.
  app.use(
    express.json({
      limit: '1mb',
      verify: (req: Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });

  app.post('/webhook', (req: Request & { rawBody?: Buffer }, res: Response) => {
    // 1. Verify signature FIRST. No body parsing or logging until this passes.
    const sig = req.header('X-Hub-Signature-256');
    if (!req.rawBody || !verifySignature(req.rawBody, sig, config.webhookSecret)) {
      return res.status(401).json({ error: 'invalid signature' });
    }

    const eventType = req.header('X-GitHub-Event') ?? '';
    const deliveryId = req.header('X-GitHub-Delivery');
    const payload = req.body as WebhookPayload;

    // 2. Replay guard: every authenticated delivery id is recorded for 24h; a
    // repeat is acknowledged but never processed again.
    try {
      if (deliveryId && deliveries.checkAndRecord(deliveryId)) {
        return res.status(200).json({ status: 'duplicate' });
      }
    } catch (err) {
      console.error('dedupe store failed:', err);
      return res.status(500).json({ error: 'dedupe failed' });
    }

    // 3. Drop bots before anything else (anti-loop guard).
    if (isBotSender(payload)) {
      return res.status(204).end();
    }

    // 4. Drop events for repos not on the allowlist, even with a valid signature.
    if (!isAllowedRepo(payload, config.allowedRepos)) {
      return res.status(204).end();
    }

    // 5. Map to a TaskTrigger; 204 if the event isn't one we care about.
    const trigger = mapToTrigger(eventType, payload, {
      triggerLabel: config.triggerLabel,
      statusLabel: config.statusLabel,
      botMention: config.botMention,
    });
    if (!trigger) {
      return res.status(204).end();
    }

    // 6. Enqueue and ack. GitHub gives us ~10s; we ack inside ~100ms by doing
    // one synchronous queue-file write (plus the dedupe insert above) and no
    // further work.
    try {
      const triggerId = enqueue(config.workspaceDir, trigger);
      console.log(
        `enqueued triggerId=${triggerId} source=${trigger.source} ` +
          `repo=${trigger.repo.owner}/${trigger.repo.name} issue=#${trigger.issue.number} ` +
          `delivery=${deliveryId ?? 'none'}`,
      );
      return res.status(202).json({ triggerId });
    } catch (err) {
      console.error('enqueue failed:', err);
      // Nothing was queued: let GitHub's redelivery (same id) through.
      if (deliveryId) deliveries.forget(deliveryId);
      return res.status(500).json({ error: 'enqueue failed' });
    }
  });

  return app;
}