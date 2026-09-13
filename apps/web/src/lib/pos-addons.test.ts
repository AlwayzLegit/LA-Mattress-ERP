import { describe, expect, it } from 'vitest';
import { lineHasAddons } from './pos-addons';

describe('lineHasAddons', () => {
  it('follows the catalog category root on real STORIS names (A22.1 subcategories)', () => {
    expect(
      lineHasAddons({ categoryPath: 'Mattresses › Innerspring', description: 'E KING MICAH FIRM' }),
    ).toBe(true);
    expect(
      lineHasAddons({
        categoryPath: 'Mattresses › Hybrid',
        description: 'QUEEN PROADAPT 2.0 MEDIUM',
      }),
    ).toBe(true);
    expect(
      lineHasAddons({
        categoryPath: 'Adjustable Bases › Adjustable Bed Bases',
        description: 'CAKING 1P ADJUST ERGO SMART',
      }),
    ).toBe(true);
    expect(
      lineHasAddons({
        categoryPath: 'Foundations & Box Springs › Low Profile (4–5")',
        description: 'QUEEN LOW PROFILE FOUNDATION',
      }),
    ).toBe(true);
    expect(
      lineHasAddons({
        categoryPath: 'Foundations & Box Springs › Bunkie Board (2")',
        description: 'QUEEN BUNKIE',
      }),
    ).toBe(true);
    // Filed on the root itself (the four unsorted mattresses).
    expect(lineHasAddons({ categoryPath: 'Mattresses', description: 'E KING MICAH FIRM' })).toBe(
      true,
    );
  });

  it('keeps accessories off even under a sleep-surface root or with a mattress-sounding name', () => {
    expect(
      lineHasAddons({
        categoryPath: 'Adjustable Bases › Base Accessories & Parts',
        description: 'ERGO REMOTE',
      }),
    ).toBe(false);
    expect(
      lineHasAddons({
        categoryPath: 'Mattress Protection › Mattress Protectors',
        description: 'QUEEN MATTRESS PROTECTOR',
      }),
    ).toBe(false);
    expect(
      lineHasAddons({ categoryPath: 'Bedding › Toppers & Mattress Pads', description: 'Q TOPPER' }),
    ).toBe(false);
    expect(lineHasAddons({ categoryPath: 'Pillows', description: 'QUEEN PROADAPT PILLOW' })).toBe(
      false,
    );
    expect(
      lineHasAddons({
        categoryPath: 'Bed Frames › Metal Bed Frames',
        description: 'Q METAL FRAME',
      }),
    ).toBe(false);
  });

  it('falls back to the name only when there is no category', () => {
    expect(lineHasAddons({ categoryPath: null, description: 'Cloud Comfort Mattress' })).toBe(true);
    expect(lineHasAddons({ categoryPath: null, description: 'Adjustable base' })).toBe(true);
    expect(lineHasAddons({ categoryPath: null, description: 'Mattress protector' })).toBe(false);
    expect(lineHasAddons({ categoryPath: null, description: 'Memory foam pillow' })).toBe(false);
  });

  it('never offers chips on custom fee lines', () => {
    expect(
      lineHasAddons({ categoryPath: null, description: 'Mattress removal', lineType: 'custom' }),
    ).toBe(false);
  });
});
