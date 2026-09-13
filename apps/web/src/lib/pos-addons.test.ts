import { describe, expect, it } from 'vitest';
import { lineHasAddons } from './pos-addons';

describe('lineHasAddons', () => {
  it('follows the catalog category on real STORIS names', () => {
    expect(lineHasAddons({ categoryName: 'Mattresses', description: 'E KING MICAH FIRM' })).toBe(
      true,
    );
    expect(
      lineHasAddons({
        categoryName: 'Adjustable Bases',
        description: 'CAKING 1P ADJUST ERGO SMART',
      }),
    ).toBe(true);
    expect(
      lineHasAddons({
        categoryName: 'Foundations & Box Springs',
        description: 'QUEEN LOW PROFILE FOUNDATION',
      }),
    ).toBe(true);
  });

  it('keeps accessories off even when the name sounds like a mattress', () => {
    expect(
      lineHasAddons({
        categoryName: 'Mattress Protection',
        description: 'QUEEN MATTRESS PROTECTOR',
      }),
    ).toBe(false);
    expect(lineHasAddons({ categoryName: 'Pillows', description: 'QUEEN PROADAPT PILLOW' })).toBe(
      false,
    );
    expect(lineHasAddons({ categoryName: 'Bed Frames', description: 'Q METAL FRAME' })).toBe(false);
  });

  it('falls back to the name only when there is no category', () => {
    expect(lineHasAddons({ categoryName: null, description: 'Cloud Comfort Mattress' })).toBe(true);
    expect(lineHasAddons({ categoryName: null, description: 'Adjustable base' })).toBe(true);
    expect(lineHasAddons({ categoryName: null, description: 'Mattress protector' })).toBe(false);
    expect(lineHasAddons({ categoryName: null, description: 'Memory foam pillow' })).toBe(false);
  });

  it('never offers chips on custom fee lines', () => {
    expect(
      lineHasAddons({ categoryName: null, description: 'Mattress removal', lineType: 'custom' }),
    ).toBe(false);
  });
});
