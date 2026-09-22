import { describe, it, expect } from 'vitest';
import { nairaToKobo } from '../src/utils/money.js';

describe('wallet amounts', () => {
  it('uses integer kobo only', () => {
    const a = nairaToKobo(10);
    const b = nairaToKobo(20);
    expect(a + b).toBe(3000n);
    expect(typeof (a + b)).toBe('bigint');
  });
});