import { describe, expect, it } from 'vitest';
import {
  CARD_BRANDS,
  FINANCING_TERM_MONTHS,
  cardBrandLabel,
  isCardBrand,
  isCardMethod,
  isFinancingMethod,
  isFinancingTerm,
} from './tenders.js';

describe('tender subcategories', () => {
  it('accepts every cataloged card brand and rejects junk', () => {
    for (const b of CARD_BRANDS) expect(isCardBrand(b.value)).toBe(true);
    expect(isCardBrand('VISA')).toBe(false);
    expect(isCardBrand('')).toBe(false);
    expect(isCardBrand('bitcoin')).toBe(false);
  });

  it('labels brands and passes unknown stored values through', () => {
    expect(cardBrandLabel('visa')).toBe('Visa');
    expect(cardBrandLabel('amex')).toBe('American Express');
    expect(cardBrandLabel(null)).toBeNull();
    expect(cardBrandLabel(undefined)).toBeNull();
    // A value stored before the catalog changed still renders.
    expect(cardBrandLabel('legacy_brand')).toBe('legacy_brand');
  });

  it('accepts exactly the offered financing terms', () => {
    for (const m of FINANCING_TERM_MONTHS) expect(isFinancingTerm(m)).toBe(true);
    expect(isFinancingTerm(0)).toBe(false);
    expect(isFinancingTerm(9)).toBe(false);
    expect(isFinancingTerm(60)).toBe(false);
  });

  it('classifies methods', () => {
    expect(isCardMethod('card')).toBe(true);
    expect(isCardMethod('external_card')).toBe(true);
    expect(isCardMethod('cash')).toBe(false);
    expect(isFinancingMethod('synchrony')).toBe(true);
    expect(isFinancingMethod('acima')).toBe(true);
    expect(isFinancingMethod('financing')).toBe(true);
    expect(isFinancingMethod('card')).toBe(false);
  });
});
