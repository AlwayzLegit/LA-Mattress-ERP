import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PrintablePurchaseOrder,
  poAddressLines,
  type PrintablePo,
} from './printable-purchase-order';

function po(over: Partial<PrintablePo> = {}): PrintablePo {
  return {
    number: 'PO-2026-000109',
    createdAt: '2026-11-17T20:00:00Z',
    placedAt: '2026-11-17T20:00:00Z',
    expectedAt: '2026-11-24T20:00:00Z',
    vendorName: 'Tempur-Sealy',
    vendorContactName: null,
    vendorEmail: null,
    vendorPhone: '6264351010',
    vendorAddressJson: {
      line1: '825 Ajax',
      city: 'Rowland Heights',
      region: 'CA',
      postalCode: '91748',
    },
    locationName: 'LA Mattress Warehouse',
    locationAddressJson: {
      line1: '7356 Ethel Ave',
      line2: 'We call 6-8pm night before del',
      city: 'North Hollywood',
      region: 'CA',
      postalCode: '91605',
      phone: '8187596089',
    },
    businessName: 'Los Angeles Mattress Plus',
    notes: null,
    subtotalCents: 126500,
    freightCents: null,
    lines: [
      {
        productName: 'E KING ESTATE FIRM TT',
        variantName: null,
        sku: '53008961',
        vendorSku: '53008961',
        quantityOrdered: 1,
        unitCostCents: 126500,
        lineTotalCents: 126500,
        linkedOrders: [
          {
            orderId: 'o1',
            orderNumber: 'KO-10187',
            quantity: 1,
            customerName: 'Xiaotong Zhao',
          },
        ],
      },
    ],
    ...over,
  };
}

describe('purchase order prints like the STORIS PO (owner 2026-11-17)', () => {
  it('letterhead, boxed number and dates, vendor and ship-to boxes', () => {
    const html = renderToStaticMarkup(<PrintablePurchaseOrder po={po()} mode="page" />);
    expect(html).toContain('LOS ANGELES MATTRESS PLUS');
    expect(html).toContain('7356 ETHEL AVE');
    expect(html).toContain('Purchase Order');
    expect(html).toContain('PO-2026-000109');
    expect(html).toContain('Document Date');
    expect(html).toContain('11/24/26');
    expect(html).toContain('TEMPUR-SEALY');
    expect(html).toContain('825 AJAX');
    expect(html).toContain('ROWLAND HEIGHTS, CA 91748');
    expect(html).toContain('Phone: 626-435-1010');
    expect(html).toContain('LA MATTRESS WAREHOUSE');
    expect(html).toContain('WE CALL 6-8PM NIGHT BEFORE DEL');
    expect(html).toContain('Ship Via');
    expect(html).toContain('Terms');
    expect(html).toContain('Remarks');
  });

  it('line grid with model, vendor model and the reserved-for line, then totals', () => {
    const html = renderToStaticMarkup(<PrintablePurchaseOrder po={po()} mode="page" />);
    expect(html).toContain('Vendor Model');
    expect(html).toContain('E KING ESTATE FIRM TT');
    expect(html).toContain('Reserved for Order # KO-10187, XIAOTONG ZHAO');
    expect(html).toContain('Total Quantity:');
    expect(html).toContain('Merchandise Subtotal:');
    expect(html).toContain('Total Order Amount:');
    expect(html).toContain('$1,265.00');
    expect(html).not.toContain('Freight:');
  });

  it('freight adds into the order total', () => {
    const html = renderToStaticMarkup(
      <PrintablePurchaseOrder po={po({ freightCents: 5000 })} mode="page" />,
    );
    expect(html).toContain('Freight:');
    expect(html).toContain('$1,315.00');
  });

  it('direct ship prints the customer in the Ship To box', () => {
    const html = renderToStaticMarkup(
      <PrintablePurchaseOrder
        po={po({
          directShip: true,
          shipToJson: { name: 'Xiaotong Zhao', address: { line1: '1 Main St', city: 'Burbank' } },
        })}
        mode="page"
      />,
    );
    expect(html).toContain('Ship To (direct)');
    expect(html).toContain('XIAOTONG ZHAO');
    expect(html).toContain('1 MAIN ST');
  });

  it('address lines read the structured shape and legacy loose values', () => {
    expect(
      poAddressLines({ line1: '1 A St', city: 'LA', state: 'CA', zip: '90001', phone: '1' }),
    ).toEqual(['1 A St', 'LA, CA 90001']);
    expect(poAddressLines(['5 B Ave'])).toEqual(['5 B Ave']);
    expect(poAddressLines(null)).toEqual([]);
  });
});
