/**
 * Design tokens — the literal values from the redesign hand-off
 * (`design_handoff_redesign_12_phases/README.md` §1, canvas
 * `Redesign 2 System.dc.html` artboard 2d). `globals.css` is the source
 * of truth the browser reads; this module mirrors it for code that has
 * to name a token (the `/dev/tokens` sheet, Phase 2's StatusChip, print
 * documents that cannot read CSS variables).
 */

export interface ColorToken {
  token: string;
  cssVar: string;
  hex: string;
  use: string;
}

export const NEUTRALS: ColorToken[] = [
  { token: 'bg', cssVar: '--bg', hex: '#f6f5f2', use: 'app background' },
  { token: 'surface', cssVar: '--surface', hex: '#ffffff', use: 'sheets, rows' },
  { token: 'surface-2', cssVar: '--surface-2', hex: '#efeeea', use: 'hover, zebra, disabled' },
  { token: 'border', cssVar: '--border', hex: '#dcd9d2', use: 'hairlines' },
  { token: 'border-strong', cssVar: '--border-strong', hex: '#bdb9b0', use: 'inputs on hover' },
  { token: 'text', cssVar: '--text', hex: '#1c1b18', use: 'primary · 15.6:1 on surface' },
  { token: 'text-2', cssVar: '--text-2', hex: '#4a4843', use: 'secondary · 8.6:1' },
  { token: 'muted', cssVar: '--muted', hex: '#6f6c65', use: 'labels · 5.1:1' },
  { token: 'faint', cssVar: '--faint', hex: '#9b978e', use: 'decoration only, never text' },
];

export const ACCENTS: ColorToken[] = [
  {
    token: 'accent',
    cssVar: '--accent',
    hex: '#1e3a5f',
    use: 'primary button, links, focus ring · 10.4:1 on surface',
  },
  {
    token: 'accent-soft',
    cssVar: '--accent-soft',
    hex: '#e7edf5',
    use: 'selected row, today cell',
  },
  { token: 'accent-ink', cssVar: '--accent-ink', hex: '#16304f', use: 'hover on links' },
];

export type StatusKey = 'draft' | 'waiting' | 'scheduled' | 'fulfilled' | 'cancelled' | 'risk';

export interface StatusToken {
  key: StatusKey;
  glyph: string;
  label: string;
  fg: string;
  bg: string;
  border: string;
  /** The word is struck for Cancelled; never hidden from lists. */
  strike: boolean;
  ratio: string;
  when: string;
}

/** Status chips — always glyph + word + colour, 1px border of the tint. */
export const STATUSES: StatusToken[] = [
  {
    key: 'draft',
    glyph: '○',
    label: 'Draft',
    fg: '#6f6c65',
    bg: '#efeeea',
    border: '#dcd9d2',
    strike: false,
    ratio: '4.8:1',
    when: 'nothing reserved, editable',
  },
  {
    key: 'waiting',
    glyph: '◔',
    label: 'Waiting on stock',
    fg: '#8a5a00',
    bg: '#fbf1dc',
    border: '#f0d9a6',
    strike: false,
    ratio: '5.6:1',
    when: 'at least one line short or on PO',
  },
  {
    key: 'scheduled',
    glyph: '◷',
    label: 'Scheduled',
    fg: '#1f5fa8',
    bg: '#e5eef9',
    border: '#c9dcf2',
    strike: false,
    ratio: '5.3:1',
    when: 'delivery date set, fully reserved',
  },
  {
    key: 'fulfilled',
    glyph: '✓',
    label: 'Fulfilled',
    fg: '#1a6e43',
    bg: '#e3f2e9',
    border: '#bfe0cc',
    strike: false,
    ratio: '5.4:1',
    when: 'delivered, picked up, or taken',
  },
  {
    key: 'cancelled',
    glyph: '✕',
    label: 'Cancelled',
    fg: '#6f6c65',
    bg: '#efeeea',
    border: '#dcd9d2',
    strike: true,
    ratio: '4.8:1',
    when: 'word struck; never hidden from lists',
  },
  {
    key: 'risk',
    glyph: '▲',
    label: 'At risk',
    fg: '#b3261e',
    bg: '#fbe7e5',
    border: '#f0c4c0',
    strike: false,
    ratio: '5.9:1',
    when: 'promise date inside lead time, not reserved',
  },
];

export interface TypeToken {
  token: string;
  className: string;
  family: 'Archivo' | 'Public Sans' | 'JetBrains Mono';
  size: string;
  weight: number;
  lineHeight: string;
  letterSpacing: string;
  sample: string;
}

export const TYPE_SCALE: TypeToken[] = [
  {
    token: 'display-xl',
    className: 't-display-xl',
    family: 'Archivo',
    size: '44–56px',
    weight: 600,
    lineHeight: '1',
    letterSpacing: '-.02em',
    sample: '$18,960',
  },
  {
    token: 'display-l',
    className: 't-display-l',
    family: 'Archivo',
    size: '26–30px',
    weight: 600,
    lineHeight: '1.1',
    letterSpacing: '-.015em',
    sample: '14 / 15 stops',
  },
  {
    token: 'heading',
    className: 't-heading',
    family: 'Archivo',
    size: '18px',
    weight: 600,
    lineHeight: '1.2',
    letterSpacing: '-.01em',
    sample: 'Cancel SO-10437?',
  },
  {
    token: 'title',
    className: 't-title',
    family: 'Public Sans',
    size: '15px',
    weight: 600,
    lineHeight: '1.3',
    letterSpacing: '0',
    sample: 'Items · 4 lines',
  },
  {
    token: 'body',
    className: 't-body',
    family: 'Public Sans',
    size: '13px',
    weight: 400,
    lineHeight: '1.5',
    letterSpacing: '0',
    sample: 'Balance due at door.',
  },
  {
    token: 'body-register',
    className: 't-body-register',
    family: 'Public Sans',
    size: '14px',
    weight: 400,
    lineHeight: '1.5',
    letterSpacing: '0',
    sample: 'Cloud Comfort Mattress, Queen',
  },
  {
    token: 'label',
    className: 't-label',
    family: 'Public Sans',
    size: '11px',
    weight: 600,
    lineHeight: '1.2',
    letterSpacing: '.05em',
    sample: 'Inventory from',
  },
  {
    token: 'mono',
    className: 't-mono',
    family: 'JetBrains Mono',
    size: '12–13px',
    weight: 400,
    lineHeight: '1.4',
    letterSpacing: '0',
    sample: 'SO-10437 · CCM-Q · $1,299.00',
  },
];

export const SPACE_SCALE = [4, 8, 12, 16, 24, 32, 48] as const;

export const RADII = [
  { token: 'radius-chip', px: 3, use: 'chips, status' },
  { token: 'radius-input', px: 3, use: 'inputs, selects' },
  { token: 'radius-button', px: 5, use: 'buttons' },
  { token: 'radius-card', px: 5, use: 'cards, dialogs, menus' },
  { token: 'radius-sheet', px: 0, use: 'tables, sheets' },
] as const;

export const DENSITIES = [
  { key: 'management', row: 36, text: 13, control: 30, hit: 30 },
  { key: 'register', row: 44, text: 14, control: 38, hit: 44 },
] as const;
