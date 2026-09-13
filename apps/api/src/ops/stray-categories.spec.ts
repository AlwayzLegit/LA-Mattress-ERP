import { describe, expect, it } from 'vitest';
import { classifyStray } from './stray-categories';

describe('classifyStray', () => {
  it('reads the STORIS group code and refines by the description', () => {
    expect(classifyStray('QUEEN', 'QUEEN COBALT FIRM')).toEqual({
      category: 'Mattresses',
      subcategory: null,
    });
    expect(classifyStray('QUEEN', 'QUEEN NATASHA LATEX PLUSH')).toEqual({
      category: 'Mattresses',
      subcategory: 'Latex',
    });
    expect(classifyStray('CAKING', 'CAKING TEMPUR-ADAPT MEDIUM HYBRID')).toEqual({
      category: 'Mattresses',
      subcategory: 'Hybrid',
    });
    expect(classifyStray('QUFND', 'QUEEN LP FND 5"')).toEqual({
      category: 'Foundations & Box Springs',
      subcategory: 'Low Profile (4–5")',
    });
    expect(classifyStray('TXLFND', 'TXL BB')).toEqual({
      category: 'Foundations & Box Springs',
      subcategory: 'Bunkie Board (2")',
    });
    expect(classifyStray('CKPRO', 'CK ZIPPERED ENCASEMENT')).toEqual({
      category: 'Mattress Protection',
      subcategory: 'Encasements & Covers',
    });
    expect(classifyStray('QUPRO', 'QUEEN TERRY PROTECTOR')).toEqual({
      category: 'Mattress Protection',
      subcategory: 'Mattress Protectors',
    });
    expect(classifyStray('PILLOW', 'TEMPUR-CLOUD PILLOW')).toEqual({
      category: 'Pillows',
      subcategory: 'Memory Foam Pillows',
    });
    expect(classifyStray('FRAMES', 'QUEEN BED FRAME WITH WHEELS')).toEqual({
      category: 'Bed Frames',
      subcategory: 'Metal Bed Frames',
    });
    expect(classifyStray('FRAMES', 'BEDBEAM CENTER SUPPORT')).toEqual({
      category: 'Bed Frames',
      subcategory: 'Frame Parts & Hardware',
    });
    expect(classifyStray('HBOARD', 'QUEEN GRENADA HB')).toEqual({
      category: 'Bedroom Furniture',
      subcategory: 'Headboards',
    });
  });

  it('reads connector product types, case-insensitively', () => {
    expect(classifyStray('Hybrid Mattress', 'Helix Midnight Luxe Queen')).toEqual({
      category: 'Mattresses',
      subcategory: 'Hybrid',
    });
    expect(classifyStray('Bed in a Box', 'Eclipse Cares Joyfulness')).toEqual({
      category: 'Mattresses',
      subcategory: null,
    });
    expect(classifyStray('mws_fee_generated', 'Recycling fee')).toEqual({
      category: 'Services & Fees',
      subcategory: 'Fees',
    });
  });

  it('says nothing about a name the tree does not know', () => {
    expect(classifyStray('Gizmos', 'Widget')).toBeNull();
  });
});
