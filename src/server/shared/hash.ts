import { createHash } from 'crypto';

export function blake2s256(input: string): string {
  return createHash('blake2s256').update(input).digest('hex');
}
