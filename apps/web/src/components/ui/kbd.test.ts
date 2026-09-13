import { describe, expect, it } from 'vitest';
import { formatKeys } from './kbd';

describe('formatKeys', () => {
  it('renders mod as ⌘ on a Mac and Ctrl elsewhere', () => {
    expect(formatKeys('mod+k', 'mac')).toBe('⌘K');
    expect(formatKeys('mod+k', 'other')).toBe('Ctrl K');
  });
  it('passes function keys and single letters through', () => {
    expect(formatKeys('F8', 'mac')).toBe('F8');
    expect(formatKeys('n', 'other')).toBe('N');
  });
  it('spells out chords with a space', () => {
    expect(formatKeys('g o', 'mac')).toBe('G O');
    expect(formatKeys('shift+enter', 'other')).toBe('Shift ↵');
  });
  it('names escape per platform', () => {
    expect(formatKeys('esc', 'mac')).toBe('esc');
    expect(formatKeys('esc', 'other')).toBe('Esc');
  });
});
