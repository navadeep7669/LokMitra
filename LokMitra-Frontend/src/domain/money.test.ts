import { describe, expect, it } from 'vitest';
import { gstInPaise, MAX_AMOUNT_PAISE, paiseToRupees, rupeesToPaise } from './money';

describe('money helpers', () => {
  it('converts only valid rupee amounts to integer paise', () => {
    expect(rupeesToPaise('₹1,234.50')).toBe(123450);
    expect(rupeesToPaise('0')).toBeNull();
    expect(rupeesToPaise('1.001')).toBeNull();
    expect(rupeesToPaise('10000000')).toBe(MAX_AMOUNT_PAISE);
  });

  it('formats Indian rupees and computes GST in paise', () => {
    expect(paiseToRupees(123450)).toContain('1,234.50');
    expect(gstInPaise(10001)).toBe(1800);
    expect(() => paiseToRupees(0.5)).toThrow();
  });
});
