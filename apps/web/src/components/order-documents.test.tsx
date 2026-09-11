import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { InvoiceDoc, invoiceAccent, onAccent, type OrderDocumentPayload } from './order-documents';

function payload(over: Partial<OrderDocumentPayload['order']> = {}): OrderDocumentPayload {
  return {
    business: {
      name: 'LA Mattress Stores',
      logoUrl: null,
      accentColor: '#0f766e',
      invoiceHeaderNote: 'WE CALL 6-8PM NIGHT BEFORE DEL',
      invoiceFooterNote: 'All sales final on clearance items.',
    },
    location: {
      name: 'West LA',
      orderPrefix: '02',
      addressJson: { line1: '11911 Santa Monica Blvd', city: 'Los Angeles', region: 'CA' },
    },
    customer: {
      id: 'c1',
      name: 'Chloe McAuley',
      email: null,
      phone: '646-248-2297',
      address: {
        line1: '2947 Tilden Ave',
        line2: null,
        city: 'Los Angeles',
        region: 'CA',
        postalCode: '90064',
      },
    },
    salespersonName: 'Ronnie Ortiz',
    secondSalespersonName: null,
    originalOrderNumber: null,
    scheduledDate: '2026-09-14',
    order: {
      id: 'o1',
      number: 'SO-2026-000075',
      status: 'confirmed',
      orderKind: 'sales_order',
      fulfillmentType: 'delivery',
      subtotalCents: 241700,
      discountCents: 0,
      orderDiscountCents: 0,
      taxCents: 23390,
      totalCents: 265090,
      paidCents: 50000,
      balanceDueCents: 215090,
      creditDueCents: 0,
      deliveryFeeCents: 0,
      installFeeCents: 0,
      otherFeeCents: 0,
      otherFeeLabel: null,
      addressLine1: null,
      addressLine2: null,
      addressCity: null,
      addressRegion: null,
      addressPostalCode: null,
      addressPhone: null,
      deliveryInstructions: null,
      notes: null,
      lockedAt: null,
      createdAt: '2026-09-10T20:00:00.000Z',
      payments: [
        {
          id: 'p1',
          method: 'card',
          amountCents: 50000,
          status: 'succeeded',
          createdAt: '2026-09-10T20:05:00.000Z',
        },
      ],
      ...over,
    },
    lines: [
      {
        id: 'l1',
        description: 'Tempur-Pedic Adapt Medium Queen',
        quantity: 1,
        qtyReserved: 1,
        qtyFulfilled: 0,
        lineType: 'product',
        unitPriceCents: 239900,
        discountCents: 0,
        totalCents: 239900,
        fulfillmentMethod: 'delivery',
        model: 'TP-ADAPT-M-Q',
        brand: 'Tempur-Pedic',
        bin: null,
        comment: 'Leave at side door',
      },
      {
        id: 'l2',
        description: 'CA mattress recycling fee',
        quantity: 1,
        qtyReserved: 0,
        qtyFulfilled: 0,
        lineType: 'custom',
        unitPriceCents: 1800,
        discountCents: 0,
        totalCents: 1800,
        fulfillmentMethod: null,
        model: null,
        brand: null,
        bin: null,
      },
    ],
    familyInvoice: null,
  };
}

const render = (doc: OrderDocumentPayload) =>
  renderToStaticMarkup(<InvoiceDoc doc={doc} printedAt={new Date('2026-09-11T02:00:00Z')} />);

describe('InvoiceDoc (§11, modern layout)', () => {
  it('prints the brand accent, the number and an Amount due callout', () => {
    const html = render(payload());
    expect(html).toContain('Sales Order');
    expect(html).toContain('SO-2026-000075');
    expect(html).toContain('#0f766e');
    expect(html).toMatch(/Amount due[\s\S]*\$2,150\.90/);
    expect(html).toContain('WE CALL 6-8PM NIGHT BEFORE DEL');
    expect(html).toContain('All sales final on clearance items.');
    expect(html).toContain('Ronnie Ortiz');
    expect(html).toContain('02 West LA');
  });

  it('keeps Merchandise goods-only with the recycling fee broken out (BA-0015)', () => {
    const html = render(payload());
    expect(html).toMatch(/Merchandise[\s\S]*\$2,399\.00/);
    expect(html).toMatch(/Recycling[\s\S]*\$18\.00/);
    expect(html).toContain('TP-ADAPT-M-Q · Tempur-Pedic');
    expect(html).toContain('Leave at side door');
    expect(html).toContain('Credit card');
  });

  it('says Paid in full when nothing is owed', () => {
    const html = render(payload({ paidCents: 265090, balanceDueCents: 0 }));
    // The callout says Paid in full; "Amount due" then appears once only,
    // as the $0.00 row of the totals card.
    expect(html).toMatch(/invoice-callout[\s\S]*?Paid in full/);
    expect(html.match(/Amount due/g)).toHaveLength(1);
  });

  it('titles an exchange, prints the original invoice and Credit due', () => {
    const doc = payload({ orderKind: 'exchange', balanceDueCents: 0, creditDueCents: 12500 });
    doc.originalOrderNumber = 'SO-2026-000016';
    const html = render(doc);
    expect(html).toContain('Exchange Order');
    expect(html).toContain('SO-2026-000016');
    expect(html).toMatch(/Credit due[\s\S]*\$125\.00/);
  });

  it('falls back to a neutral accent and picks readable text on the accent', () => {
    expect(invoiceAccent(null)).toBe('#1f2937');
    expect(invoiceAccent('not-a-color')).toBe('#1f2937');
    expect(invoiceAccent('#ABCDEF')).toBe('#abcdef');
    expect(onAccent('#1f2937')).toBe('#ffffff');
    expect(onAccent('#facc15')).toBe('#111111');
    const html = render({ ...payload(), business: { ...payload().business, accentColor: null } });
    expect(html).toContain('#1f2937');
  });
});
