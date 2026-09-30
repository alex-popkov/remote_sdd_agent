import { describe, it, expect } from 'vitest';
import crypto from 'node:crypto';
import { verifySignature } from '../src/verifySignature';

const SECRET = 'test-secret';

function sign(body: Buffer | string): string {
  const buf = typeof body === 'string' ? Buffer.from(body) : body;
  return 'sha256=' + crypto.createHmac('sha256', SECRET).update(buf).digest('hex');
}

describe('verifySignature', () => {
  it('accepts a valid signature', () => {
    const body = Buffer.from('{"hello":"world"}');
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it('rejects a tampered body', () => {
    const body = Buffer.from('{"hello":"world"}');
    const sig = sign(body);
    expect(verifySignature(Buffer.from('{"hello":"WORLD"}'), sig, SECRET)).toBe(false);
  });

  it('rejects a missing header', () => {
    expect(verifySignature(Buffer.from('x'), undefined, SECRET)).toBe(false);
  });

  it('rejects a malformed header without the sha256= prefix', () => {
    const body = Buffer.from('x');
    const digest = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifySignature(body, digest, SECRET)).toBe(false);
  });

  it('rejects a header of the wrong length without throwing', () => {
    // crypto.timingSafeEqual throws on length mismatch — verifySignature guards
    // against that explicitly. Pass a short hex to confirm we return false.
    expect(verifySignature(Buffer.from('x'), 'sha256=deadbeef', SECRET)).toBe(false);
  });

  it('rejects a signature signed with the wrong secret', () => {
    const body = Buffer.from('payload');
    const wrong = 'sha256=' + crypto.createHmac('sha256', 'other-secret').update(body).digest('hex');
    expect(verifySignature(body, wrong, SECRET)).toBe(false);
  });
});