import { createHash, timingSafeEqual } from 'node:crypto';
export const hashCode = (code: string) => createHash('sha256').update(code.trim().toUpperCase()).digest('hex');
export function matchesSecret(actual: unknown, expected: string | undefined): boolean {
  if (typeof actual !== 'string' || !expected || expected.length < 32) return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
export class UserError extends Error {}
