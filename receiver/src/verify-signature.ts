import crypto from 'node:crypto';

/**
 * Verifies GitHub webhook signature.
 *
 * GitHub sends X-Hub-Signature-256 header with format: "sha256=<hex>"
 * We compute HMAC-SHA256 over the raw body using our shared secret
 * and compare in constant time.
 *
 * IMPORTANT: must be computed over the RAW request body (bytes),
 * not the parsed JSON. express.json({ verify: ... }) gives us access
 * to req.rawBody for this purpose.
 */
export function verifyGitHubSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const expected = signatureHeader.slice('sha256='.length);
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // Length check first — timingSafeEqual throws on mismatched lengths.
  if (expected.length !== computed.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(expected, 'hex'),
    Buffer.from(computed, 'hex'),
  );
}
