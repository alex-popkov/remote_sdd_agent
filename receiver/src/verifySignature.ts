import crypto from 'node:crypto';

/**
 * Verify a GitHub `X-Hub-Signature-256` header against the raw request body.
 *
 * The HMAC MUST be computed over the original byte stream — not parsed JSON
 * or a re-stringified version — because re-serialization may reorder keys or
 * normalize whitespace and break the digest. Express captures rawBody via the
 * `verify` callback on `express.json`.
 *
 * Comparison uses `crypto.timingSafeEqual` against equal-length buffers to
 * avoid leaking secret bytes through response-time differences.
 */
export function verifySignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  if (!signatureHeader) return false;
  if (!signatureHeader.startsWith('sha256=')) return false;

  const provided = signatureHeader.slice('sha256='.length);
  const computed = crypto
    .createHmac('sha256', secret)
    .update(rawBody)
    .digest('hex');

  // timingSafeEqual throws on length mismatch — guard explicitly so a malformed
  // header returns false instead of raising.
  if (provided.length !== computed.length) return false;

  return crypto.timingSafeEqual(
    Buffer.from(provided, 'hex'),
    Buffer.from(computed, 'hex'),
  );
}