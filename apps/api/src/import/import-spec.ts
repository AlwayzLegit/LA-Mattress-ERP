/**
 * The import pipeline's pure layer (STORIS cutover §7, decision D7):
 * entity specs, STORIS-shaped default column mappings, the CSV parser,
 * and the value coercions. No I/O — everything here is unit-testable
 * and replayed verbatim on the final delta run.
 */

export type FieldType = 'string' | 'money' | 'int' | 'date' | 'bool';

export interface FieldSpec {
  name: string;
  type: FieldType;
  required?: boolean;
  /** Candidate CSV headers, matched case/underscore/space-insensitively. */
  headers: string[];
}

export interface EntitySpec {
  entity: string;
  label: string;
  /**
   * Which normalized field is the STORIS identity (`legacy_refs.legacy_id`).
   * Composite identities (inventory = sku@location, order lines =
   * order#line) are derived in `legacyIdFor`.
   */
  legacyIdField: string;
  fields: FieldSpec[];
}

/** Order matters: FK targets first — the wizard walks this list top-down. */
export const ENTITY_SPECS: EntitySpec[] = [
  {
    entity: 'customer',
    label: 'Customers',
    legacyIdField: 'accountNo',
    fields: [
      {
        name: 'accountNo',
        type: 'string',
        required: true,
        headers: ['CUST#', 'CUSTOMER#', 'ACCOUNT#', 'ACCT_NO', 'CUSTOMER_ID', 'ACCOUNT_NO'],
      },
      { name: 'firstName', type: 'string', headers: ['FIRST_NAME', 'FNAME', 'FIRST'] },
      { name: 'lastName', type: 'string', headers: ['LAST_NAME', 'LNAME', 'LAST'] },
      { name: 'email', type: 'string', headers: ['EMAIL', 'EMAIL_ADDR', 'EMAIL_ADDRESS'] },
      { name: 'phone', type: 'string', headers: ['PHONE', 'PHONE1', 'TELEPHONE', 'PHONE_NO'] },
      { name: 'addressLine1', type: 'string', headers: ['ADDRESS1', 'ADDR1', 'ADDRESS'] },
      { name: 'addressLine2', type: 'string', headers: ['ADDRESS2', 'ADDR2'] },
      { name: 'city', type: 'string', headers: ['CITY'] },
      { name: 'region', type: 'string', headers: ['STATE', 'REGION', 'PROVINCE'] },
      { name: 'postalCode', type: 'string', headers: ['ZIP', 'ZIP_CODE', 'POSTAL_CODE', 'POSTAL'] },
      { name: 'notes', type: 'string', headers: ['NOTES', 'COMMENTS'] },
    ],
  },
  {
    entity: 'vendor',
    label: 'Vendors',
    legacyIdField: 'vendorNo',
    fields: [
      {
        name: 'vendorNo',
        type: 'string',
        required: true,
        headers: ['VENDOR#', 'VEND_NO', 'VENDOR_ID', 'VENDOR_NO'],
      },
      { name: 'name', type: 'string', required: true, headers: ['VENDOR_NAME', 'NAME'] },
      { name: 'contactName', type: 'string', headers: ['CONTACT', 'CONTACT_NAME'] },
      { name: 'email', type: 'string', headers: ['EMAIL', 'EMAIL_ADDR'] },
      { name: 'phone', type: 'string', headers: ['PHONE', 'TELEPHONE'] },
    ],
  },
  {
    entity: 'product',
    label: 'Products / SKUs',
    legacyIdField: 'sku',
    fields: [
      {
        name: 'sku',
        type: 'string',
        required: true,
        headers: ['SKU', 'ITEM#', 'MODEL#', 'ITEM_NO', 'MODEL'],
      },
      {
        name: 'name',
        type: 'string',
        required: true,
        headers: ['DESCRIPTION', 'ITEM_DESC', 'NAME', 'DESC'],
      },
      { name: 'category', type: 'string', headers: ['CATEGORY', 'CAT', 'CATG'] },
      // STORIS Active Inventory export (owner 2026-09-03): Brand becomes the
      // catalog brand; Group (QUEEN, CAKING, QUFND, …) is STORIS's size /
      // product group — kept as the variant's `group` attribute, not a
      // category.
      { name: 'brand', type: 'string', headers: ['BRAND', 'MFG', 'MANUFACTURER', 'BRAND_NAME'] },
      {
        name: 'group',
        type: 'string',
        headers: ['GROUP', 'PRODUCT_GROUP', 'SIZE_GROUP', 'STORIS_GROUP'],
      },
      // A22.2: an explicit size / firmness column wins; otherwise the
      // importer reads them off the group code and the description.
      { name: 'size', type: 'string', headers: ['SIZE', 'MATTRESS_SIZE', 'BED_SIZE'] },
      {
        name: 'firmness',
        type: 'string',
        headers: ['FIRMNESS', 'COMFORT', 'COMFORT_LEVEL', 'FEEL'],
      },
      {
        // Optional by decision D12: STORIS exports carry cost only and the
        // merchant prices at the register. Absent → new variants land at 0
        // (unsellable until priced) and existing variants keep their price
        // (a Shopify-synced price survives the STORIS import).
        name: 'priceCents',
        type: 'money',
        headers: ['RETAIL', 'PRICE', 'SELL_PRICE', 'RETAIL_PRICE'],
      },
      {
        name: 'costCents',
        type: 'money',
        headers: ['COST', 'UNIT_COST', 'AVG_COST', 'REPLACE_COST'],
      },
      { name: 'serialTracked', type: 'bool', headers: ['SERIALIZED', 'SERIAL_FLAG', 'SERIAL'] },
      { name: 'barcode', type: 'string', headers: ['UPC', 'BARCODE'] },
      { name: 'description', type: 'string', headers: ['LONG_DESC', 'LONG_DESCRIPTION'] },
      // Purchasing enrichment (STORIS inventory exports carry all three):
      // the vendor's own part number when it differs from our SKU, the
      // vendor to buy from (created on the fly), and the min-stock level
      // that becomes the variant's reorder point.
      {
        name: 'vendorSku',
        type: 'string',
        headers: ['VENDOR_MODEL', 'VENDOR_MODEL_NUMBER', 'VENDOR_MODEL#', 'MFG_MODEL', 'MFR_MODEL'],
      },
      { name: 'vendorName', type: 'string', headers: ['VENDOR', 'SUPPLIER', 'VENDOR_NAME'] },
      {
        name: 'reorderPoint',
        type: 'int',
        headers: ['MIN_STOCK', 'REORDER_POINT', 'MIN_QTY', 'MIN'],
      },
    ],
  },
  {
    entity: 'inventory',
    label: 'Inventory on hand',
    legacyIdField: 'sku', // composite — see legacyIdFor
    fields: [
      {
        name: 'sku',
        type: 'string',
        required: true,
        headers: ['SKU', 'ITEM#', 'MODEL#', 'ITEM_NO'],
      },
      {
        name: 'location',
        type: 'string',
        required: true,
        headers: ['LOCATION', 'STORE', 'WAREHOUSE', 'LOC'],
      },
      {
        name: 'onHand',
        type: 'int',
        required: true,
        headers: ['ON_HAND', 'QTY_ON_HAND', 'QOH', 'QTY'],
      },
      { name: 'unitCostCents', type: 'money', headers: ['UNIT_COST', 'AVG_COST', 'COST'] },
      // STORIS Active Inventory (owner 2026-09-03): the as-is units at this
      // store (a subset of ON_HAND — the converter adds them in) and the
      // store's minimum stock, which becomes the level's reorder point and
      // rolls up into the variant's.
      { name: 'asIsQty', type: 'int', headers: ['AS_IS', 'QUANTITY_AS_IS', 'AS_IS_QTY', 'ASIS'] },
      {
        name: 'reorderPoint',
        type: 'int',
        headers: ['MIN_STOCK', 'MIN', 'REORDER_POINT', 'MIN_QTY'],
      },
    ],
  },
  {
    entity: 'order',
    label: 'Open orders (headers)',
    legacyIdField: 'orderNo',
    fields: [
      {
        name: 'orderNo',
        type: 'string',
        required: true,
        headers: ['ORDER#', 'SO#', 'SALES_ORDER#', 'ORDER_NO'],
      },
      {
        name: 'customerAccountNo',
        type: 'string',
        required: true,
        headers: ['CUST#', 'CUSTOMER#', 'ACCOUNT#', 'ACCT_NO', 'CUSTOMER_ID'],
      },
      { name: 'location', type: 'string', required: true, headers: ['LOCATION', 'STORE', 'LOC'] },
      { name: 'orderDate', type: 'date', headers: ['ORDER_DATE', 'DATE', 'WRITTEN_DATE'] },
      {
        name: 'promisedDate',
        type: 'date',
        headers: ['PROMISED_DATE', 'PROMISE_DATE', 'DELIVERY_DATE'],
      },
      { name: 'status', type: 'string', headers: ['STATUS', 'ORDER_STATUS'] },
      {
        name: 'totalCents',
        type: 'money',
        required: true,
        headers: ['TOTAL', 'ORDER_TOTAL', 'TOTAL_AMT'],
      },
      { name: 'taxCents', type: 'money', headers: ['TAX', 'TAX_AMT', 'SALES_TAX'] },
      {
        name: 'depositCents',
        type: 'money',
        headers: ['DEPOSIT', 'DEPOSITS_HELD', 'DEPOSIT_AMT', 'DEPOSITS'],
      },
      { name: 'notes', type: 'string', headers: ['NOTES', 'COMMENTS'] },
    ],
  },
  {
    entity: 'order_line',
    label: 'Open orders (lines)',
    legacyIdField: 'orderNo', // composite — see legacyIdFor
    fields: [
      {
        name: 'orderNo',
        type: 'string',
        required: true,
        headers: ['ORDER#', 'SO#', 'SALES_ORDER#', 'ORDER_NO'],
      },
      { name: 'lineNo', type: 'int', headers: ['LINE#', 'LINE_NO', 'SEQ', 'LINE'] },
      {
        name: 'sku',
        type: 'string',
        required: true,
        headers: ['SKU', 'ITEM#', 'MODEL#', 'ITEM_NO'],
      },
      { name: 'description', type: 'string', headers: ['DESCRIPTION', 'ITEM_DESC', 'DESC'] },
      {
        name: 'quantity',
        type: 'int',
        required: true,
        headers: ['QTY', 'QUANTITY', 'QTY_ORDERED'],
      },
      {
        name: 'unitPriceCents',
        type: 'money',
        required: true,
        headers: ['UNIT_PRICE', 'PRICE', 'SELL_PRICE'],
      },
      {
        name: 'totalCents',
        type: 'money',
        headers: ['EXT_PRICE', 'LINE_TOTAL', 'EXTENDED', 'EXT_AMT'],
      },
    ],
  },
  {
    entity: 'sale',
    label: 'Closed sales history (per invoice)',
    legacyIdField: 'invoiceNo',
    fields: [
      {
        name: 'invoiceNo',
        type: 'string',
        required: true,
        headers: ['INVOICE#', 'TICKET#', 'SALE#', 'INVOICE_NO'],
      },
      {
        name: 'customerAccountNo',
        type: 'string',
        headers: ['CUST#', 'CUSTOMER#', 'ACCOUNT#', 'ACCT_NO'],
      },
      { name: 'location', type: 'string', required: true, headers: ['LOCATION', 'STORE', 'LOC'] },
      {
        name: 'saleDate',
        type: 'date',
        required: true,
        headers: ['DATE', 'SALE_DATE', 'INVOICE_DATE'],
      },
      {
        name: 'totalCents',
        type: 'money',
        required: true,
        headers: ['TOTAL', 'INVOICE_TOTAL', 'TOTAL_AMT'],
      },
      { name: 'taxCents', type: 'money', headers: ['TAX', 'TAX_AMT', 'SALES_TAX'] },
      { name: 'method', type: 'string', headers: ['TENDER', 'PAYMENT_METHOD', 'PAY_TYPE'] },
    ],
  },
  {
    // Owner 2026-08-31: imported receipts showed only money — the sale
    // export is header-per-invoice and never carried the items. This
    // entity attaches the per-item lines to already-committed sale
    // headers by invoice number. An unknown SKU is fine: the line keeps
    // its description (legacy models need not exist in the catalog).
    entity: 'sale_line',
    label: 'Closed sales history lines (per item)',
    legacyIdField: 'invoiceNo',
    fields: [
      {
        name: 'invoiceNo',
        type: 'string',
        required: true,
        headers: ['INVOICE#', 'TICKET#', 'SALE#', 'INVOICE_NO'],
      },
      { name: 'lineNo', type: 'int', headers: ['LINE#', 'LINE_NO', 'SEQ', 'LINE'] },
      { name: 'sku', type: 'string', headers: ['SKU', 'ITEM#', 'MODEL#', 'ITEM_NO'] },
      { name: 'description', type: 'string', headers: ['DESCRIPTION', 'ITEM_DESC', 'DESC'] },
      {
        name: 'quantity',
        type: 'int',
        required: true,
        headers: ['QTY', 'QUANTITY', 'QTY_SOLD'],
      },
      {
        name: 'unitPriceCents',
        type: 'money',
        required: true,
        headers: ['UNIT_PRICE', 'PRICE', 'SELL_PRICE'],
      },
      {
        name: 'totalCents',
        type: 'money',
        headers: ['EXT_PRICE', 'LINE_TOTAL', 'EXTENDED', 'EXT_AMT'],
      },
    ],
  },
];

export const entitySpec = (entity: string): EntitySpec | undefined =>
  ENTITY_SPECS.find((s) => s.entity === entity);

/** The `legacy_refs` identity for one normalized row. */
export function legacyIdFor(entity: string, n: Record<string, unknown>): string | null {
  if (entity === 'inventory') {
    return n.sku && n.location ? `${String(n.sku)}@${String(n.location)}` : null;
  }
  if (entity === 'order_line') {
    if (!n.orderNo) return null;
    const line = n.lineNo != null ? String(n.lineNo) : n.sku ? String(n.sku) : null;
    return line ? `${String(n.orderNo)}#${line}` : null;
  }
  if (entity === 'sale_line') {
    if (!n.invoiceNo) return null;
    const line = n.lineNo != null ? String(n.lineNo) : n.sku ? String(n.sku) : null;
    return line ? `${String(n.invoiceNo)}#${line}` : null;
  }
  const spec = entitySpec(entity);
  if (!spec) return null;
  const v = n[spec.legacyIdField];
  return v == null || v === '' ? null : String(v);
}

// --- CSV (RFC 4180: quoted fields, embedded commas/quotes/newlines) ---

export function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, ''); // strip BOM
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      record.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      record.push(field);
      field = '';
      records.push(record);
      record = [];
    } else {
      field += c;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  // Drop fully-empty trailing lines.
  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ''));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };
  const headers = nonEmpty[0]!.map((h) => h.trim());
  const rows = nonEmpty.slice(1).map((r) => {
    const obj: Record<string, string> = {};
    headers.forEach((h, idx) => {
      obj[h] = (r[idx] ?? '').trim();
    });
    return obj;
  });
  return { headers, rows };
}

// --- Default mapping ---

const canon = (h: string) => h.toUpperCase().replace(/[\s_#-]/g, '');

/**
 * Column → field mapping. Auto-derived at staging from the STORIS-shaped
 * candidates above (a header equal to the field name itself also
 * matches, so hand-built fixture CSVs map with zero config), then
 * editable in the wizard and replayed on the delta run.
 */
export function defaultMapping(entity: string, headers: string[]): Record<string, string> {
  const spec = entitySpec(entity);
  if (!spec) return {};
  const byCanon = new Map(headers.map((h) => [canon(h), h]));
  const mapping: Record<string, string> = {};
  for (const f of spec.fields) {
    const candidates = [f.name, ...f.headers];
    for (const c of candidates) {
      const hit = byCanon.get(canon(c));
      if (hit !== undefined) {
        mapping[f.name] = hit;
        break;
      }
    }
  }
  return mapping;
}

// --- Coercions ---

export interface RowError {
  field: string;
  message: string;
}

/**
 * "$1,234.56", "1234.5", "(45.00)" → integer cents. Returns null for
 * blank, undefined for unparseable (an error, unlike blank).
 */
export function parseMoneyCents(raw: string): number | null | undefined {
  let s = raw.trim();
  if (s === '') return null;
  let sign = 1;
  if (/^\(.*\)$/.test(s)) {
    sign = -1;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,\s]/g, '');
  if (s.startsWith('-')) {
    sign *= -1;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return undefined;
  const [dollars, frac = ''] = s.split('.');
  return sign * (Number(dollars) * 100 + Number((frac + '00').slice(0, 2)));
}

export function parseDateValue(raw: string): Date | null | undefined {
  const s = raw.trim();
  if (s === '') return null;
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) {
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(s);
  if (m) {
    let year = Number(m[3]);
    if (year < 100) year += 2000;
    const d = new Date(Date.UTC(year, Number(m[1]) - 1, Number(m[2])));
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  return undefined;
}

const TRUE_WORDS = new Set(['Y', 'YES', 'TRUE', 'T', '1']);
const FALSE_WORDS = new Set(['N', 'NO', 'FALSE', 'F', '0', '']);

/**
 * Apply a mapping to a raw CSV row and coerce every mapped field.
 * Dates normalize to ISO strings so `normalized_json` round-trips
 * through jsonb.
 */
export function normalizeRow(
  entity: string,
  raw: Record<string, string>,
  mapping: Record<string, string>,
): { normalized: Record<string, unknown>; errors: RowError[] } {
  const spec = entitySpec(entity);
  if (!spec)
    return { normalized: {}, errors: [{ field: '*', message: `unknown entity ${entity}` }] };
  const normalized: Record<string, unknown> = {};
  const errors: RowError[] = [];
  for (const f of spec.fields) {
    const header = mapping[f.name];
    const rawValue = header !== undefined ? (raw[header] ?? '') : '';
    if (rawValue.trim() === '') {
      if (f.required) {
        errors.push({
          field: f.name,
          message:
            header === undefined ? 'required column is not mapped' : 'required value is blank',
        });
      }
      continue;
    }
    switch (f.type) {
      case 'string':
        normalized[f.name] = rawValue.trim();
        break;
      case 'money': {
        const cents = parseMoneyCents(rawValue);
        if (cents === undefined)
          errors.push({ field: f.name, message: `bad money value "${rawValue}"` });
        else if (cents !== null) normalized[f.name] = cents;
        break;
      }
      case 'int': {
        const s = rawValue.replace(/,/g, '').trim();
        if (!/^-?\d+$/.test(s)) errors.push({ field: f.name, message: `bad number "${rawValue}"` });
        else normalized[f.name] = Number(s);
        break;
      }
      case 'date': {
        const d = parseDateValue(rawValue);
        if (d === undefined) errors.push({ field: f.name, message: `bad date "${rawValue}"` });
        else if (d !== null) normalized[f.name] = d.toISOString();
        break;
      }
      case 'bool': {
        const w = rawValue.trim().toUpperCase();
        if (TRUE_WORDS.has(w)) normalized[f.name] = true;
        else if (FALSE_WORDS.has(w)) normalized[f.name] = false;
        else errors.push({ field: f.name, message: `bad yes/no value "${rawValue}"` });
        break;
      }
    }
  }
  return { normalized, errors };
}
