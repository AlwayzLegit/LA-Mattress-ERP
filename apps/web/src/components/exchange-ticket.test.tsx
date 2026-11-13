import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  ExchangeTicketDoc,
  type ExchangeTicketExchange,
  type ExchangeTicketReturn,
} from './exchange-ticket';
import type { OrderDocumentPayload } from './order-documents';

function exchange(over: Partial<ExchangeTicketExchange> = {}): ExchangeTicketExchange {
  return {
    id: 'x1',
    number: 'EX-2026-000007',
    status: 'open',
    evenExchange: false,
    restockingFeeCents: 0,
    returnId: 'r1',
    rmaNumber: 'RMA-WE-10090-1',
    returnStatus: 'authorized',
    returnCents: 135497,
    saleOrderId: 'o2',
    saleOrderNumber: 'WE-10092',
    saleOrderStatus: 'confirmed',
    saleTotalCents: 201780,
    originalOrderNumber: 'WE-10090',
    referencedOrderNumber: null,
    customerName: 'Paul Thomas',
    createdAt: '2026-11-05T18:00:00.000Z',
    completedAt: null,
    splitAt: null,
    notes: null,
    returnSalespersonName: 'Ronnie Ortiz',
    fulfillment: 'drop_off',
    refundTender: 'store_credit',
    ticketPrintCount: 0,
    settlement: {
      returnCents: 135497,
      restockingFeeCents: 0,
      creditCents: 135497,
      saleTotalCents: 201780,
      salePaidCents: 0,
      saleBalanceDueCents: 201780,
    },
    ...over,
  };
}

function ret(over: Partial<ExchangeTicketReturn> = {}): ExchangeTicketReturn {
  return {
    rmaNumber: 'RMA-WE-10090-1',
    status: 'authorized',
    fulfillment: 'drop_off',
    refundMethod: 'store_credit',
    amountCents: 135497,
    reason: null,
    restockingFeeCents: 0,
    pickupFeeCents: 0,
    pickupDate: null,
    authorizedAt: '2026-11-05T18:00:00.000Z',
    goodsReceivedAt: null,
    completedAt: null,
    orderNumber: 'WE-10090',
    orderDate: '2026-10-20T19:00:00.000Z',
    customerName: 'Paul Thomas',
    customerPhone: '3107405614',
    customerEmail: null,
    addressLine1: '25242 Malibu Rd',
    addressLine2: null,
    addressCity: 'Malibu',
    addressRegion: 'CA',
    addressPostalCode: '90265',
    locationName: 'West LA',
    salespersonName: 'Ronnie Ortiz',
    businessName: 'LA Mattress Stores',
    linesTotalCents: 135497,
    pickup: null,
    lines: [
      {
        id: 'rl1',
        description: 'Queen Arise Quilted Firm',
        quantity: 1,
        perUnitCents: 135497,
        reasonCode: 'COMFORT',
        reason: 'Too firm',
      },
    ],
    ...over,
  };
}

function sale(): OrderDocumentPayload {
  return {
    business: {
      name: 'LA Mattress Stores',
      logoUrl: 'https://cdn.example/logo.png',
      accentColor: '#0f766e',
      invoiceHeaderNote: null,
      invoiceFooterNote: 'Thank you for sleeping better with us.',
    },
    location: {
      name: 'West LA',
      orderPrefix: 'WE',
      addressJson: { line1: '11911 Santa Monica Blvd', city: 'Los Angeles', region: 'CA' },
    },
    customer: {
      id: 'c1',
      name: 'Paul Thomas',
      email: 'paul@example.com',
      phone: '3107405614',
      address: {
        line1: '25242 Malibu Rd',
        line2: null,
        city: 'Malibu',
        region: 'CA',
        postalCode: '90265',
      },
    },
    salespersonName: 'Dana Lee',
    secondSalespersonName: null,
    originalOrderNumber: 'WE-10090',
    scheduledDate: '2026-11-09',
    order: {
      id: 'o2',
      number: 'WE-10092',
      status: 'confirmed',
      orderKind: 'exchange',
      fulfillmentType: 'delivery',
      subtotalCents: 164880,
      discountCents: 0,
      orderDiscountCents: 0,
      taxCents: 15664,
      totalCents: 201780,
      paidCents: 0,
      balanceDueCents: 201780,
      creditDueCents: 0,
      deliveryFeeCents: 12900,
      installFeeCents: 0,
      otherFeeCents: 8336,
      otherFeeLabel: 'Haul away',
      addressLine1: '25242 Malibu Rd',
      addressLine2: null,
      addressCity: 'Malibu',
      addressRegion: 'CA',
      addressPostalCode: '90265',
      addressPhone: null,
      deliveryInstructions: 'Gate code 4411',
      notes: null,
      lockedAt: null,
      createdAt: '2026-11-05T18:10:00.000Z',
      payments: [],
    },
    lines: [
      {
        id: 'l1',
        description: 'Queen Midnight-Luxe Medium',
        quantity: 1,
        qtyReserved: 1,
        qtyFulfilled: 0,
        lineType: 'product',
        unitPriceCents: 164880,
        discountCents: 0,
        totalCents: 164880,
        fulfillmentMethod: 'delivery',
        model: 'MID-LUX-M-Q',
        brand: 'Sealy',
        bin: null,
      },
    ],
    familyInvoice: null,
  };
}

const printedAt = new Date('2026-11-05T20:00:00Z');
const render = (
  x: ExchangeTicketExchange,
  r: ExchangeTicketReturn | null,
  s: OrderDocumentPayload | null,
) =>
  renderToStaticMarkup(<ExchangeTicketDoc exchange={x} ret={r} sale={s} printedAt={printedAt} />);

describe('ExchangeTicketDoc (owner 2026-11-05: invoice dress, dates, detail)', () => {
  it('prints the logo, brand accent, store, both legs and a Balance due callout', () => {
    const html = render(exchange(), ret(), sale());
    expect(html).toContain('https://cdn.example/logo.png');
    expect(html).toContain('#0f766e');
    expect(html).toContain('11911 Santa Monica Blvd');
    expect(html).toContain('EX-2026-000007');
    expect(html).toContain('RMA-WE-10090-1');
    expect(html).toContain('WE-10092');
    expect(html).toContain('WE-10090');
    // Both salespeople: who took the return and who wrote the replacement.
    expect(html).toContain('Ronnie Ortiz');
    expect(html).toContain('Dana Lee');
    // Return line with its reason and the replacement with model/brand.
    expect(html).toContain('COMFORT — Too firm');
    expect(html).toContain('MID-LUX-M-Q · Sealy');
    // Full replacement totals with tax, then the netting.
    expect(html).toMatch(/Tax[\s\S]*\$156\.64/);
    expect(html).toContain('Haul away');
    expect(html).toMatch(/Return credit[\s\S]*-\$1,354\.97/);
    expect(html).toMatch(/Net exchange[\s\S]*\$662\.83/);
    expect(html).toMatch(/Balance due[\s\S]*\$662\.83/);
    expect(html).toContain('Thank you for sleeping better with us.');
    expect(html).toContain('Gate code 4411');
  });

  it('goods back, replacement not yet delivered: the store-credit tender is the credit, not a second payment (owner 2026-11-12)', () => {
    // EX-2026-000014: the customer paid the net at the counter, the truck
    // picked the old mattress up, the replacement still rides tomorrow's
    // truck. The exchange is open, the return completed, the replacement
    // paid in full by card + the store-credit tender the receipt minted.
    const s = sale();
    s.order.paidCents = 201780;
    s.order.balanceDueCents = 0;
    s.order.payments = [
      {
        id: 'p1',
        method: 'card',
        amountCents: 66283,
        status: 'succeeded',
        createdAt: '2026-11-05T18:20:00.000Z',
        cardBrand: 'visa',
      },
      {
        id: 'p2',
        method: 'store_credit',
        amountCents: 135497,
        status: 'succeeded',
        createdAt: '2026-11-06T18:20:00.000Z',
      },
    ];
    const html = render(
      exchange({
        fulfillment: 'pickup',
        returnStatus: 'completed',
        settlement: {
          returnCents: 135497,
          restockingFeeCents: 0,
          creditCents: 135497,
          saleTotalCents: 201780,
          salePaidCents: 201780,
          saleBalanceDueCents: 0,
        },
      }),
      ret({
        fulfillment: 'pickup',
        status: 'completed',
        goodsReceivedAt: '2026-11-06T18:20:00.000Z',
      }),
      s,
    );
    expect(html).toMatch(/Paid on replacement[\s\S]*-\$662\.83/);
    expect(html).not.toContain('Refund due');
    expect(html).toContain('Settled — nothing due');
  });

  it('lays out the dates: original invoice, entered, authorized, goods back, delivery, completed', () => {
    const html = render(exchange(), ret(), sale());
    expect(html).toContain('Original invoice');
    expect(html).toContain('Exchange entered');
    expect(html).toContain('Return authorized');
    expect(html).toContain('Goods dropped off');
    expect(html).toContain('Exchange completed');
    expect(html).toContain(new Date('2026-10-20T19:00:00.000Z').toLocaleDateString());
    expect(html).toContain(new Date('2026-11-09T00:00:00').toLocaleDateString());
  });

  it('shows the truck pickup window while the goods are still out, and the received date after', () => {
    const pickup = ret({
      fulfillment: 'pickup',
      pickup: {
        scheduledDate: '2026-11-08',
        windowStart: '09:00:00',
        windowEnd: '12:00:00',
        status: 'scheduled',
        contactStatus: null,
      },
    });
    const before = render(exchange({ fulfillment: 'pickup' }), pickup, sale());
    expect(before).toContain('Our truck picks up');
    expect(before).toContain('09:00–12:00');
    const after = render(
      exchange({ fulfillment: 'pickup', returnStatus: 'completed' }),
      ret({
        fulfillment: 'pickup',
        status: 'completed',
        goodsReceivedAt: '2026-11-08T17:00:00.000Z',
      }),
      sale(),
    );
    expect(after).toContain('Picked up');
    expect(after).toContain('Goods received');
  });

  it('nets a refund when the credit exceeds the replacement, naming the tender', () => {
    const html = render(
      exchange({
        saleTotalCents: 100000,
        refundTender: 'original',
        settlement: {
          returnCents: 135497,
          restockingFeeCents: 0,
          creditCents: 135497,
          saleTotalCents: 100000,
          salePaidCents: 0,
          saleBalanceDueCents: 100000,
        },
      }),
      ret(),
      sale(),
    );
    expect(html).toMatch(/Refund due · original form of payment[\s\S]*\$354\.97/);
  });

  it('withholds the restocking fee and marks an even exchange', () => {
    const html = render(
      exchange({
        evenExchange: true,
        restockingFeeCents: 10000,
        settlement: {
          returnCents: 135497,
          restockingFeeCents: 10000,
          creditCents: 125497,
          saleTotalCents: 201780,
          salePaidCents: 0,
          saleBalanceDueCents: 201780,
        },
      }),
      ret(),
      sale(),
    );
    expect(html).toContain('Even exchange');
    expect(html).toMatch(/Restocking fee withheld[\s\S]*\$100\.00/);
    expect(html).toMatch(/Balance due[\s\S]*\$762\.83/);
  });

  it('pre-cutover original (dispatcher 2026-11-06): names the STORIS invoice, no order date', () => {
    const html = render(
      exchange({
        originalOrderNumber: null,
        referencedOrderNumber: '03108303',
        rmaNumber: 'RMA-NOORIG-3',
        fulfillment: 'pickup',
        returnStatus: 'authorized',
      }),
      ret({
        orderNumber: null,
        orderDate: null,
        fulfillment: 'pickup',
        pickupDate: '2026-11-08',
        rmaNumber: 'RMA-NOORIG-3',
      }),
      sale(),
    );
    expect(html).toContain('03108303');
    expect(html).toContain('STORIS, not on file');
    expect(html).toContain('STORIS (before cutover)');
    expect(html).toContain('RMA-NOORIG-3');
    expect(html).toContain(new Date('2026-11-08T00:00:00').toLocaleDateString());
    expect(html).toMatch(/Return credit[\s\S]*-\$1,354\.97/);
  });

  it('uses the replacement balance once settled and still renders without the legs', () => {
    const settled = render(
      exchange({
        status: 'completed',
        completedAt: '2026-11-08T17:00:00.000Z',
        settlement: {
          returnCents: 135497,
          restockingFeeCents: 0,
          creditCents: 135497,
          saleTotalCents: 201780,
          salePaidCents: 201780,
          saleBalanceDueCents: 0,
        },
      }),
      ret(),
      sale(),
    );
    expect(settled).toContain('Settled — nothing due');
    const bare = render(exchange(), null, null);
    expect(bare).toContain('EX-2026-000007');
    expect(bare).toContain('Return lines unavailable.');
    expect(bare).toContain('#0f2057');
  });
});
