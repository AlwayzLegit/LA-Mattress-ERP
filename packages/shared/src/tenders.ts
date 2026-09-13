/**
 * Tender subcategories recorded at payment time so the store dashboards
 * can break card volume down by brand and financing volume down by term.
 * One catalog for the register UI, the back-office order page, and the
 * API's validation.
 */

export const CARD_BRANDS = [
  { value: 'visa', label: 'Visa' },
  { value: 'mastercard', label: 'Mastercard' },
  { value: 'amex', label: 'American Express' },
  { value: 'discover', label: 'Discover' },
  { value: 'jcb', label: 'JCB' },
  { value: 'diners', label: 'Diners Club' },
  { value: 'other', label: 'Other' },
] as const;
export type CardBrand = (typeof CARD_BRANDS)[number]['value'];

export function isCardBrand(v: string): v is CardBrand {
  return CARD_BRANDS.some((b) => b.value === v);
}

export function cardBrandLabel(v: string | null | undefined): string | null {
  if (!v) return null;
  return CARD_BRANDS.find((b) => b.value === v)?.label ?? v;
}

/** Months-financed options offered by our financing partners. */
export const FINANCING_TERM_MONTHS = [6, 12, 15, 18, 24, 36, 48] as const;
export type FinancingTermMonths = (typeof FINANCING_TERM_MONTHS)[number];

export function isFinancingTerm(v: number): v is FinancingTermMonths {
  return (FINANCING_TERM_MONTHS as readonly number[]).includes(v);
}

/** Payment methods that carry a card brand. */
export const CARD_METHODS = ['card', 'external_card'] as const;
/** Payment methods that carry a months-financed term. */
export const FINANCING_METHODS = ['financing', 'synchrony', 'acima'] as const;

export function isCardMethod(method: string): boolean {
  return (CARD_METHODS as readonly string[]).includes(method);
}
export function isFinancingMethod(method: string): boolean {
  return (FINANCING_METHODS as readonly string[]).includes(method);
}
