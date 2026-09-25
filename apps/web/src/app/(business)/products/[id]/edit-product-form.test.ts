import { describe, expect, it } from 'vitest';
import { marginPercent, parseMoney } from './edit-product-form';

describe('parseMoney', () => {
  it('reads dollars as cents, tolerating a $ and thousands commas', () => {
    expect(parseMoney('123.45')).toBe(12345);
    expect(parseMoney('$1,299')).toBe(129900);
    expect(parseMoney(' 0 ')).toBe(0);
    expect(parseMoney('19.999')).toBe(2000);
  });

  it('blank is no amount; junk or a negative is invalid', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('   ')).toBeNull();
    expect(parseMoney('abc')).toBeUndefined();
    expect(parseMoney('-5')).toBeUndefined();
  });
});

describe('marginPercent', () => {
  it('is gross margin as a whole percent of price', () => {
    expect(marginPercent(100000, 55000)).toBe(45);
    expect(marginPercent(29999, 12000)).toBe(60);
  });

  it('goes negative when selling below cost', () => {
    expect(marginPercent(10000, 12000)).toBe(-20);
  });

  it('is unknown without a price or a cost', () => {
    expect(marginPercent(0, 100)).toBeNull();
    expect(marginPercent(10000, null)).toBeNull();
    expect(marginPercent(undefined, 100)).toBeNull();
  });
});
