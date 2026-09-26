import { describe, expect, it } from 'vitest';
import {
  bySalesperson,
  cleanDescription,
  docMatches,
  fmtPct,
  fmtTime,
  headline,
  NO_SALESPERSON,
  usedColumns,
  type Doc,
  type Report,
  type Totals,
} from './ws-lib';

const totals = (over: Partial<Totals> = {}): Totals => ({
  merchCents: 0,
  profitCents: 0,
  profitPct: null,
  chargesCents: 0,
  discountCents: 0,
  miscFeeCents: 0,
  taxCents: 0,
  totalCents: 0,
  documents: 1,
  ...over,
});

const doc = (over: Partial<Doc> = {}): Doc => ({
  documentType: 'order',
  documentId: Math.random().toString(36).slice(2),
  number: 'SO-1',
  date: '2026-09-26',
  time: '13:54',
  customerCode: 'ABC',
  customerName: 'GONZALEZ MARIA',
  customerDisplayName: 'Maria Gonzalez',
  customerPhone: '323-555-0111',
  address: null,
  salespeople: ['Ben Franklin'],
  marketingCode: null,
  adjustmentKind: null,
  adjustmentReason: null,
  comments: [],
  lines: [],
  totals: totals(),
  ...over,
});

const report = (docs: Doc[], over: Partial<Report> = {}): Report => ({
  generatedAt: '2026-09-26T20:00:00Z',
  range: { start: '2026-09-26', end: '2026-09-26' },
  orderType: 'both',
  reportType: 'detail',
  canSeeProfit: true,
  locations: [
    {
      locationId: 'l1',
      locationName: 'Koreatown',
      types: [{ key: 'orders', label: 'Sales', documents: docs, totals: totals() }],
      totals: totals(),
    },
  ],
  totals: totals({ totalCents: docs.reduce((s, d) => s + d.totals.totalCents, 0) }),
  ...over,
});

describe('formatting', () => {
  it('drops the "— Default" variant suffix only', () => {
    expect(cleanDescription('Brass Floor Lamp — Default')).toBe('Brass Floor Lamp');
    expect(cleanDescription('Linen Sofa — Beige')).toBe('Linen Sofa — Beige');
  });
  it('reads times and percents for people', () => {
    expect(fmtTime('13:54')).toBe('1:54 PM');
    expect(fmtTime('00:05')).toBe('12:05 AM');
    expect(fmtPct(62.24)).toBe('62.2%');
    expect(fmtPct(null)).toBe('—');
  });
});

describe('docMatches', () => {
  const d = doc({ number: 'KO-10031' });
  it('finds by order number, name either way round, salesperson and phone digits', () => {
    expect(docMatches(d, 'ko-100')).toBe(true);
    expect(docMatches(d, 'maria')).toBe(true);
    expect(docMatches(d, 'gonzalez')).toBe(true);
    expect(docMatches(d, 'franklin')).toBe(true);
    expect(docMatches(d, '3235550111')).toBe(true);
    expect(docMatches(d, '(323) 555')).toBe(true);
    expect(docMatches(d, 'altine')).toBe(false);
    expect(docMatches(d, '  ')).toBe(true);
  });
});

describe('headline', () => {
  it('counts sales, averages them, and sets adjustments apart', () => {
    const r = report([
      doc({ totals: totals({ totalCents: 100_00 }) }),
      doc({ totals: totals({ totalCents: 300_00 }) }),
      doc({
        documentType: 'adjustment',
        adjustmentKind: 'cancellation',
        totals: totals({ totalCents: -50_00 }),
      }),
    ]);
    expect(headline(r)).toEqual({
      writtenCents: 350_00,
      orders: 2,
      averageCents: 200_00,
      adjustmentsCents: -50_00,
      adjustments: 1,
    });
  });
});

describe('bySalesperson', () => {
  it('credits a split sale by its split and ranks by written total', () => {
    const rows = bySalesperson(
      report([
        doc({
          salespeople: ['Ben Franklin', 'Grace Chen'],
          salespersonShares: [
            { name: 'Ben Franklin', bps: 6000 },
            { name: 'Grace Chen', bps: 4000 },
          ],
          totals: totals({ totalCents: 1000_00, merchCents: 1000_00, profitCents: 500_00 }),
        }),
        doc({
          salespeople: ['Grace Chen'],
          salespersonShares: [{ name: 'Grace Chen', bps: 10_000 }],
          totals: totals({ totalCents: 800_00, merchCents: 800_00, profitCents: 200_00 }),
        }),
        doc({ salespeople: [], salespersonShares: [], totals: totals({ totalCents: 10_00 }) }),
      ]),
    );
    expect(rows.map((r) => [r.name, r.orders, r.totalCents, r.profitCents, r.profitPct])).toEqual([
      ['Grace Chen', 2, 1200_00, 400_00, 33.3],
      ['Ben Franklin', 1, 600_00, 300_00, 50],
      [NO_SALESPERSON, 1, 10_00, 0, null],
    ]);
  });

  it('an adjustment moves money but is not another order', () => {
    const rows = bySalesperson(
      report([
        doc({ totals: totals({ totalCents: 500_00, merchCents: 500_00 }) }),
        doc({
          documentType: 'adjustment',
          totals: totals({ totalCents: -100_00, merchCents: -100_00 }),
        }),
      ]),
    );
    expect(rows[0]).toMatchObject({ name: 'Ben Franklin', orders: 1, totalCents: 400_00 });
  });

  it('profit stays unknown when it is masked', () => {
    const rows = bySalesperson(report([doc({ totals: totals({ profitCents: null }) })]));
    expect(rows[0]!.profitCents).toBeNull();
    expect(rows[0]!.profitPct).toBeNull();
  });
});

describe('usedColumns', () => {
  it('shows charges and misc fees only when some document has them', () => {
    expect(usedColumns(report([doc()]))).toEqual({ charges: false, miscFee: false });
    expect(usedColumns(report([doc({ totals: totals({ chargesCents: 99_00 }) })]))).toEqual({
      charges: true,
      miscFee: false,
    });
  });
});
