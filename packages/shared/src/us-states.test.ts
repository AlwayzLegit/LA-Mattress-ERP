import { describe, expect, it } from 'vitest';
import { stateCode } from './us-states';

describe('stateCode', () => {
  it('reads codes however they were typed', () => {
    expect(stateCode('MO')).toBe('MO');
    expect(stateCode(' mo. ')).toBe('MO');
    expect(stateCode('ca')).toBe('CA');
  });
  it('reads full names', () => {
    expect(stateCode('Missouri')).toBe('MO');
    expect(stateCode('new york')).toBe('NY');
    expect(stateCode('District of Columbia')).toBe('DC');
  });
  it('is null for blanks and non-states', () => {
    expect(stateCode('')).toBeNull();
    expect(stateCode(null)).toBeNull();
    expect(stateCode('ZZ')).toBeNull();
    expect(stateCode('Ontario')).toBeNull();
  });
});
