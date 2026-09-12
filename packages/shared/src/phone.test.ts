import { describe, expect, it } from 'vitest';
import { formatPhone, phoneDigits, phonesMatch } from './phone.js';

describe('phoneDigits', () => {
  it('keeps digits and drops a leading US country code', () => {
    expect(phoneDigits('(818) 555-0142')).toBe('8185550142');
    expect(phoneDigits('+1 818 555 0142')).toBe('8185550142');
    expect(phoneDigits('818.555.0142')).toBe('8185550142');
  });
  it('refuses anything shorter than seven digits', () => {
    expect(phoneDigits('555-01')).toBe('');
    expect(phoneDigits(null)).toBe('');
    expect(phoneDigits('')).toBe('');
  });
});

describe('phonesMatch', () => {
  it('matches on the last ten digits however the number was typed', () => {
    expect(phonesMatch('(818) 555-0142', '18185550142')).toBe(true);
    expect(phonesMatch('818-555-0142', '818-555-0143')).toBe(false);
    expect(phonesMatch('', '818-555-0142')).toBe(false);
  });
});

describe('formatPhone', () => {
  it('formats a ten-digit number and leaves anything else alone', () => {
    expect(formatPhone('8185550142')).toBe('(818) 555-0142');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
  });
});
