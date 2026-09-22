import { describe, it, expect } from 'vitest';
import { nairaToKobo, formatKobo, parseUserAmountToKobo } from '../src/utils/money.js';

describe('money', () => {
  it('converts naira to kobo', () => {
    expect(nairaToKobo(1000)).toBe(100000n);
    expect(nairaToKobo(1)).toBe(100n);
  });

  it('formats kobo', () => {
    expect(formatKobo(100000n)).toContain('1,000');
  });

  it('parses user input', () => {
    expect(parseUserAmountToKobo('5000')).toBe(500000n);
    expect(parseUserAmountToKobo('5,000')).toBe(500000n);
    expect(parseUserAmountToKobo('abc')).toBeNull();
  });
});