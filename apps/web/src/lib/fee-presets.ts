/**
 * The fees offered under "Charge a fee" on an order (owner 2026-10-13).
 * Settings → Order fees keeps the business's list in `ops.feePresets`;
 * with none saved these three are offered and the amount is typed.
 */
export interface FeePreset {
  label: string;
  amountCents: number;
}

export const DEFAULT_FEE_PRESETS: FeePreset[] = [
  { label: 'Redelivery fee', amountCents: 0 },
  { label: 'Restocking fee', amountCents: 0 },
  { label: 'Trip charge', amountCents: 0 },
];

export function feePresetsOf(saved: FeePreset[] | null | undefined): FeePreset[] {
  return saved && saved.length > 0 ? saved : DEFAULT_FEE_PRESETS;
}
