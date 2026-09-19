import { describe, expect, it } from 'vitest';
import { formatPhone, formatPhoneAsTyped, phoneDigits, phonesMatch } from './phone.js';

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
  it('formats a ten-digit number with dashes and leaves anything else alone', () => {
    expect(formatPhone('8185550142')).toBe('818-555-0142');
    expect(formatPhone('(818) 555-0142')).toBe('818-555-0142');
    expect(formatPhone('+1 818 555 0142')).toBe('818-555-0142');
    expect(formatPhone('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhone(null)).toBe('');
  });
});

describe('formatPhoneAsTyped', () => {
  it('adds dashes as the digits arrive', () => {
    expect(formatPhoneAsTyped('8')).toBe('8');
    expect(formatPhoneAsTyped('818')).toBe('818');
    expect(formatPhoneAsTyped('8188')).toBe('818-8');
    expect(formatPhoneAsTyped('818800')).toBe('818-800');
    expect(formatPhoneAsTyped('8188005')).toBe('818-800-5');
    expect(formatPhoneAsTyped('8188005678')).toBe('818-800-5678');
    expect(formatPhoneAsTyped('818-800-5678')).toBe('818-800-5678');
    expect(formatPhoneAsTyped('(818) 800-5678')).toBe('818-800-5678');
    expect(formatPhoneAsTyped('18188005678')).toBe('818-800-5678');
  });
  it('leaves non-US or annotated entries as typed', () => {
    expect(formatPhoneAsTyped('+44 20 7946 0958')).toBe('+44 20 7946 0958');
    expect(formatPhoneAsTyped('818-800-5678 x12')).toBe('818-800-5678 x12');
    expect(formatPhoneAsTyped('818800567890')).toBe('818800567890');
    expect(formatPhoneAsTyped('')).toBe('');
  });
});
