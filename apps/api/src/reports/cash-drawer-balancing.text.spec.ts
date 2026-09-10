import { describe, expect, it } from 'vitest';
import type { CashDrawerBalancingReport } from './cash-drawer-balancing.controller';
import {
  LINES_PER_PAGE,
  REPORT_WIDTH,
  renderCashDrawerBalancingBody,
  renderCashDrawerBalancingPages,
  renderCashDrawerBalancingText,
  renderParameterPage,
} from './cash-drawer-balancing.text';

/** The owner's 09/01/26 sample: one store, one pay class, three card types. */
function sample(): CashDrawerBalancingReport {
  const line = (
    code: string,
    name: string,
    reference: string,
    type: string,
    cents: number,
    time: string,
    drawer: string,
  ) => ({
    paymentId: `p-${reference}-${type}`,
    kind: 'sale',
    documentType: 'sale' as const,
    documentId: reference,
    reference,
    customerId: code,
    customerCode: code,
    customerName: name,
    paymentType: type,
    tenderRef: null,
    amountCents: cents,
    referenceSubtotalCents: cents,
    day: '2026-09-01',
    time,
    drawerId: drawer,
    drawerNumber: drawer,
    operatorId: 'em',
    operatorInitials: 'EM',
    operatorName: 'Erin Miller',
    locationId: 'loc-02',
    locationName: 'WEST LA MATTRESS STOR',
  });
  const types = [
    {
      key: 'AMEX - AMERICAN EXPRESS',
      line: line(
        '02108572',
        'SYLVIA FILIPPINI',
        '02108572',
        'AMEX - AMERICAN EXPRESS',
        135_300,
        '12:20',
        'P521',
      ),
    },
    {
      key: 'MC - MASTER CARD',
      line: line(
        '02108574',
        'GERALD KRIMEN',
        '02108574',
        'MC - MASTER CARD',
        78_121,
        '13:31',
        'P620',
      ),
    },
    {
      key: 'VISA - VISA',
      line: line('0213591', 'KIM CHIGAS', '02108582', 'VISA - VISA', 124_325, '15:55', 'P487'),
    },
  ];
  return {
    generatedAt: '2026-09-02T21:06:49.000Z',
    range: { start: '2026-09-01', end: '2026-09-01', startTime: '00:00', endTime: '23:59' },
    balanceBy: 'store',
    filters: {
      locationId: 'loc-02',
      locationCode: '02',
      locationName: 'WEST LA MATTRESS STOR',
      operatorId: null,
      operatorName: null,
      drawerId: null,
      drawerState: 'all',
    },
    toleranceCents: 0,
    groups: [
      {
        key: 'loc-02',
        code: '02',
        label: 'WEST LA MATTRESS STOR',
        sublabel: null,
        count: 3,
        amountCents: 337_746,
        payClasses: [
          {
            code: 3,
            label: 'CREDIT',
            count: 3,
            amountCents: 337_746,
            paymentTypes: types.map((t) => ({
              key: t.key,
              label: t.key,
              count: 1,
              amountCents: t.line.amountCents,
              lines: [t.line],
            })),
          },
        ],
        reconciliation: { cashCents: 0, checkCents: 0, depositCents: 0 },
        drawers: [],
      },
    ],
    count: 3,
    amountCents: 337_746,
    reconciliation: { cashCents: 0, checkCents: 0, depositCents: 0 },
  };
}

const ctx = {
  businessName: 'LAMATT 11.0 Account',
  generatedAt: new Date('2026-09-02T21:06:49.000Z'),
  timezone: 'America/Los_Angeles',
};

describe('AR.317 text layout', () => {
  it('reproduces the STORIS register lines column for column', () => {
    const body = renderCashDrawerBalancingBody(sample());
    expect(body[0]).toBe('Store 02 - WEST LA MATTRESS STOR');
    expect(body[2]).toBe('Pay Class 3 - CREDIT');
    expect(body[4]).toBe('Payment Type AMEX - AMERICAN EXPRESS');
    expect(body[5]).toBe(
      '02108572     SYLVIA FILIPPINI             02108572         AMEX                   1353.00    1353.00 12:20   P521       EM',
    );
    expect(body[6]).toBe(
      '                                                  Total For Payment Type AMEX:    1353.00',
    );
    const mc = body.find((l) => l.startsWith('02108574'))!;
    expect(mc).toBe(
      '02108574     GERALD KRIMEN                02108574         MC                      781.21     781.21 13:31   P620       EM',
    );
    expect(body).toContain(
      '                                                    Total For Payment Type MC:     781.21',
    );
    expect(body).toContain(
      '                                                        Total For Pay Class 3:    3377.46',
    );
    expect(body).toContain(
      '                                                           Total For Store 02:    3377.46',
    );
    expect(body).toContain(
      '                                                                Grand Total  :    3377.46',
    );
    expect(body.slice(-5)).toEqual([
      '                                          Cash Drawer Reconciliation:',
      '                                          CASH                                   0.00',
      '                                          CHECK                                  0.00',
      '                                                                           ----------',
      '                                          Total Deposit                          0.00',
    ]);
    for (const l of body) expect(l.length).toBeLessThanOrEqual(REPORT_WIDTH);
  });

  it('prints the STORIS page header and column headers on every page', () => {
    const pages = renderCashDrawerBalancingPages(sample(), ctx);
    expect(pages).toHaveLength(2);
    const [p1, p2] = pages as [string[], string[]];
    // Byte for byte the two header lines of the owner's STORIS spool.
    expect(p1[0]).toBe(
      'Reference: AR.317.RPT                               -=- LAMATT 11.0 Account -=-                                  14:06:49 09/02/26',
    );
    expect(p1[1]).toBe(
      'As of Date 09/01/26                              Report Cash Drawer Balancing Totals                                Page: 1',
    );
    expect(p1[3]).toBe(
      'Customer                                                   Payment Type                    Reference       Drawer       Oper',
    );
    expect(p1[4]).toBe(
      'Code         Customer Name                Reference        Gift Cert./Chk. No.     Amount   Subtotal  Time Number Mgr   Init   Batch',
    );
    expect(p2[1]!.endsWith('Page: 2')).toBe(true);
    expect(p2.slice(6)).toEqual(renderParameterPage(sample()));
    for (const p of pages) expect(p.length).toBeLessThanOrEqual(LINES_PER_PAGE);
  });

  it('echoes the parameters the STORIS way', () => {
    expect(renderParameterPage(sample())).toEqual([
      '   Start Time: None',
      '   End Time: None',
      '   Balance By: S',
      '   Drawer: All',
      '   Operator: All',
      '   Store: 02',
      '   Bal Drawer Ref: All',
      '   UnBal Drawer Ref: All',
    ]);
    const narrowed = {
      ...sample(),
      balanceBy: 'drawer' as const,
      range: { start: '2026-09-01', end: '2026-09-01', startTime: '09:00', endTime: '17:30' },
      filters: {
        locationId: null,
        locationCode: null,
        locationName: null,
        operatorId: 'u1',
        operatorName: 'Erin Miller',
        drawerId: 'P521',
        drawerState: 'balanced' as const,
      },
    };
    expect(renderParameterPage(narrowed)).toEqual([
      '   Start Time: 09:00',
      '   End Time: 17:30',
      '   Balance By: D',
      '   Drawer: P521',
      '   Operator: Erin Miller',
      '   Store: All',
      '   Bal Drawer Ref: Yes',
      '   UnBal Drawer Ref: All',
    ]);
  });

  it('paginates a long register with the header repeated', () => {
    const r = sample();
    const pt = r.groups[0]!.payClasses[0]!.paymentTypes[0]!;
    pt.lines = Array.from({ length: 120 }, (_, i) => ({
      ...pt.lines[0]!,
      paymentId: `p${i}`,
      reference: `0210${String(i).padStart(4, '0')}`,
    }));
    const pages = renderCashDrawerBalancingPages(r, ctx);
    expect(pages.length).toBeGreaterThan(3);
    for (const [i, p] of pages.entries()) {
      expect(p[0]!.startsWith('Reference: AR.317.RPT')).toBe(true);
      expect(p[1]!.endsWith(`Page: ${i + 1}`)).toBe(true);
      expect(p.length).toBeLessThanOrEqual(LINES_PER_PAGE);
    }
    const text = renderCashDrawerBalancingText(r, ctx);
    expect(text.split('\f')).toHaveLength(pages.length);
  });

  it('names operator and drawer groups the way the totals expect', () => {
    const byOp = { ...sample(), balanceBy: 'operator' as const };
    byOp.groups[0] = { ...byOp.groups[0]!, code: 'EM', label: 'Erin Miller', sublabel: 'EM' };
    const body = renderCashDrawerBalancingBody(byOp);
    expect(body[0]).toBe('Operator EM - ERIN MILLER');
    expect(body).toContain(
      '                                                        Total For Operator EM:    3377.46',
    );
    const byDrawer = { ...sample(), balanceBy: 'drawer' as const };
    byDrawer.groups[0] = {
      ...byDrawer.groups[0]!,
      code: 'P521',
      label: 'Drawer P521',
      sublabel: 'WEST LA MATTRESS STOR',
    };
    const d = renderCashDrawerBalancingBody(byDrawer);
    expect(d[0]).toBe('Drawer P521 - WEST LA MATTRESS STOR');
    expect(d).toContain(
      '                                                        Total For Drawer P521:    3377.46',
    );
  });
});
