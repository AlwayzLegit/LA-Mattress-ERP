import { describe, expect, it } from 'vitest';
import { qualifiesForRecyclingFee } from './recycling-fee';

describe('qualifiesForRecyclingFee', () => {
  it('reads the category root, not the leaf (A22.1 subcategories)', () => {
    expect(
      qualifiesForRecyclingFee({ categoryPath: 'Mattresses › Hybrid', description: 'QUEEN MICAH' }),
    ).toBe(true);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Foundations & Box Springs › Low Profile (4–5")',
        description: 'Q LP FND',
      }),
    ).toBe(true);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Adjustable Bases › Adjustable Bed Bases',
        description: 'Q ERGO',
      }),
    ).toBe(true);
  });

  it('leaves accessories, bedding and pillows off even when the name says mattress', () => {
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Adjustable Bases › Base Accessories & Parts',
        description: 'ADJUSTABLE BASE REMOTE',
      }),
    ).toBe(false);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Mattress Protection › Mattress Protectors',
        description: 'QUEEN MATTRESS PROTECTOR',
      }),
    ).toBe(false);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Bedding › Toppers & Mattress Pads',
        description: 'Q PAD',
      }),
    ).toBe(false);
  });

  it('charges platform bed bases (X-Plat), not plain metal frames or frame parts', () => {
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Bed Frames › Platform & Folding Frames',
        description: 'QUEEN X-PLAT BED FRAME',
      }),
    ).toBe(true);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Bed Frames › Metal Bed Frames',
        description: 'QUEEN ENGAUGE BED FRAME',
      }),
    ).toBe(false);
    expect(
      qualifiesForRecyclingFee({
        categoryPath: 'Bed Frames › Frame Parts & Hardware',
        description: 'FRAME GLIDES',
      }),
    ).toBe(false);
    expect(qualifiesForRecyclingFee({ description: 'QUEEN X-PLAT BED FRAME' })).toBe(true);
  });

  it('falls back to the description without a category and never charges custom lines', () => {
    expect(qualifiesForRecyclingFee({ description: 'QUEEN MATTRESS' })).toBe(true);
    expect(qualifiesForRecyclingFee({ description: 'QUEEN PILLOW' })).toBe(false);
    expect(qualifiesForRecyclingFee({ description: 'QUEEN MATTRESS', lineType: 'custom' })).toBe(
      false,
    );
  });
});
