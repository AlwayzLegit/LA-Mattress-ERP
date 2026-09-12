import { describe, expect, it } from 'vitest';
import {
  FIRMNESS_LEVELS,
  MATTRESS_SIZES,
  firmnessFromText,
  normalizeFirmness,
  normalizeSize,
  sizeFromGroupCode,
  sizeFromText,
} from './catalog.js';

describe('sizes (A22.2)', () => {
  it('normalizes labels, long forms and STORIS / SKU abbreviations', () => {
    expect(normalizeSize('Queen')).toBe('Queen');
    expect(normalizeSize('cal king')).toBe('Cal King');
    expect(normalizeSize('California King')).toBe('Cal King');
    expect(normalizeSize('CA King')).toBe('Cal King');
    expect(normalizeSize('CAKING')).toBe('Cal King');
    expect(normalizeSize('Eastern King')).toBe('King');
    expect(normalizeSize('E KING')).toBe('King');
    expect(normalizeSize('TWINXL')).toBe('Twin XL');
    expect(normalizeSize('twin xl')).toBe('Twin XL');
    expect(normalizeSize('Full XL')).toBe('Full XL');
    expect(normalizeSize('SPLCAK')).toBe('Split Cal King');
    expect(normalizeSize('Split California King')).toBe('Split Cal King');
    expect(normalizeSize('SPLQUE')).toBe('Split Queen');
    expect(normalizeSize('Olympic Queen')).toBe('Olympic Queen');
    expect(normalizeSize('CUSTOM')).toBe('Custom');
    expect(normalizeSize('')).toBeNull();
    expect(normalizeSize('Frame')).toBeNull();
    expect(normalizeSize(undefined)).toBeNull();
    for (const s of MATTRESS_SIZES) expect(normalizeSize(s)).toBe(s);
  });

  it('reads the size off every sized STORIS group code and none off the unsized ones', () => {
    const cases: [string, string | null][] = [
      ['QUEEN', 'Queen'],
      ['QUFND', 'Queen'],
      ['QUADJ', 'Queen'],
      ['QUPRO', 'Queen'],
      ['QUSHEE', 'Queen'],
      ['QUPCAS', 'Queen'],
      ['KING', 'King'],
      ['EKADJ', 'King'],
      ['EKPRO', 'King'],
      ['EKSHEE', 'King'],
      ['CAKING', 'Cal King'],
      ['CKADJ', 'Cal King'],
      ['CKPRO', 'Cal King'],
      ['CKSHEE', 'Cal King'],
      ['SPLCAK', 'Split Cal King'],
      ['SCKFND', 'Split Cal King'],
      ['SCKPRO', 'Split Cal King'],
      ['SPLQUE', 'Split Queen'],
      ['SPKSHE', 'Split King'],
      ['TWIN', 'Twin'],
      ['TWFND', 'Twin'],
      ['TWADJ', 'Twin'],
      ['TWPRO', 'Twin'],
      ['TWSHEE', 'Twin'],
      ['TWINXL', 'Twin XL'],
      ['TXLFND', 'Twin XL'],
      ['TXLADJ', 'Twin XL'],
      ['TXLPRO', 'Twin XL'],
      ['TXLSHE', 'Twin XL'],
      ['FULL', 'Full'],
      ['FUFND', 'Full'],
      ['FUADJ', 'Full'],
      ['FUPRO', 'Full'],
      ['FUSHEE', 'Full'],
      ['FULLXL', 'Full XL'],
      ['FXLFND', 'Full XL'],
      ['FXLADJ', 'Full XL'],
      ['FXLPRO', 'Full XL'],
      ['CUSTOM', 'Custom'],
      ['FRAMES', null],
      ['BEDFRA', null],
      ['ADJBAS', null],
      ['PILLOW', null],
      ['PILPRO', null],
      ['TOPPER', null],
      ['HBOARD', null],
      ['SUPPLY', null],
      ['VDSDEL', null],
      ['RF', null],
      ['', null],
    ];
    for (const [code, size] of cases) expect(sizeFromGroupCode(code), code).toBe(size);
  });

  it('reads one size off a name and none off a multi-size item', () => {
    expect(sizeFromText('Queen Helix Twilight 11.5" Firm Hybrid Mattress')).toBe('Queen');
    expect(sizeFromText('Cal King Helix Midnight 12" Medium Hybrid Mattress')).toBe('Cal King');
    expect(sizeFromText('California King Helix Twilight')).toBe('Cal King');
    expect(sizeFromText('Split King Helix Sunset Luxe')).toBe('Split King');
    expect(sizeFromText('Split Cal King Adjustable Base')).toBe('Split Cal King');
    expect(sizeFromText('Twin XL Helix Dusk')).toBe('Twin XL');
    expect(sizeFromText('E KING MICAH FIRM')).toBe('King');
    expect(sizeFromText('CAKING MICAH FIRM')).toBe('Cal King');
    expect(sizeFromText('SPLIT QU LP FND 5" - 30x80')).toBe('Split Queen');
    expect(sizeFromText('OLYMPIC QUEEN MICAH E/T')).toBe('Olympic Queen');
    expect(sizeFromText('F-XL BB UNIVERSAL BLACK FND 2"')).toBe('Full XL');
    expect(sizeFromText('FULLXL MICAH E/T')).toBe('Full XL');
    expect(sizeFromText('QN HARVEST GREEN P/T (2 SIDED)')).toBe('Queen');
    expect(sizeFromText('Purple Restore')).toBeNull();
    // Fits several sizes → no size.
    expect(sizeFromText('TWIN/FULL FRAME')).toBeNull();
    expect(sizeFromText('QUEEN/FULL GRENADA HB GRAY')).toBeNull();
    expect(sizeFromText('EK/CK/QN FRAME')).toBeNull();
    expect(sizeFromText('T/F/Q/K/CK LOW PRO HD FRAME')).toBeNull();
    // A model name is not a size.
    expect(sizeFromText('KINGSTON EUROTOP')).toBeNull();
    expect(sizeFromText('E KINGMIDNIGHT LUXE MED TC/EA')).toBeNull();
  });

  it('reads firmness most specific first, with the STORIS shorthand', () => {
    expect(firmnessFromText('Twin Helix Dusk 12" Medium Firm Hybrid Mattress')).toBe('Medium Firm');
    expect(firmnessFromText('Queen Helix Twilight 11.5" Firm Hybrid Mattress')).toBe('Firm');
    expect(firmnessFromText('Purple Extra Firm King Mattress')).toBe('Extra Firm');
    expect(firmnessFromText('AVALON ULTRA-X-FIRM')).toBe('Extra Firm');
    expect(firmnessFromText('CHRISTIAN XFIRM')).toBe('Extra Firm');
    expect(firmnessFromText('MARBLE ET EXTRA-FIRM')).toBe('Extra Firm');
    expect(firmnessFromText('LUX-ESTATE ULTR FM TT')).toBe('Extra Firm');
    expect(firmnessFromText('CASSATT LUXURY FIRM')).toBe('Medium Firm');
    expect(firmnessFromText('STOCKHOLM LATEX FM')).toBe('Firm');
    expect(firmnessFromText('DIANA LATEX MED')).toBe('Medium');
    expect(firmnessFromText('ADAPT 2.0 MEDIUM HYBRID')).toBe('Medium');
    expect(firmnessFromText('LUXEADAPT 2.0 SOFT')).toBe('Plush');
    expect(firmnessFromText('Split King Helix Sunset Luxe 13.5" Plush Hybrid')).toBe('Plush');
    expect(firmnessFromText('ESTATE SOFT EPT')).toBe('Plush');
    expect(firmnessFromText('Helix Moonlight Medium Soft')).toBe('Plush');
    expect(firmnessFromText('MICAH E/T')).toBeNull();
    expect(firmnessFromText('Adjustable Base')).toBeNull();
    expect(normalizeFirmness('medium firm')).toBe('Medium Firm');
    expect(normalizeFirmness('Soft')).toBe('Plush');
    expect(normalizeFirmness('')).toBeNull();
    for (const f of FIRMNESS_LEVELS) expect(normalizeFirmness(f)).toBe(f);
  });
});
