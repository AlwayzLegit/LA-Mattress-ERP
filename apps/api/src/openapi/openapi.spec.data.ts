/**
 * Hand-curated OpenAPI 3.1 spec for Jetnine's public API surface.
 *
 * Why hand-curated rather than generated: the public surface is a
 * focused subset of the controller layer (admin / web-only routes
 * are intentionally excluded), and an auto-generated spec would
 * leak those endpoints. Maintaining this file alongside controllers
 * is ~10 minutes per added endpoint.
 *
 * Served from `/v1/openapi.json` (machine-readable) and
 * `/v1/docs` (browsable Swagger UI). Both are @Public(); the spec
 * itself isn't sensitive.
 */
import { PRODUCT_PURCHASE_STATUSES } from '@jetnine/shared';

const PageEnvelope = (itemsRef: string) => ({
  type: 'object',
  required: ['data', 'nextCursor'],
  properties: {
    data: { type: 'array', items: { $ref: itemsRef } },
    nextCursor: {
      type: 'string',
      nullable: true,
      description:
        'Opaque cursor for the next page. Round-trip to `?cursor=`. `null` on the last page.',
    },
  },
});

const ErrorObject = {
  type: 'object',
  required: ['statusCode', 'message'],
  properties: {
    statusCode: { type: 'integer', example: 400 },
    message: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
    error: { type: 'string', example: 'Bad Request' },
  },
};

const cursorParam = {
  in: 'query',
  name: 'cursor',
  schema: { type: 'string' },
  description: 'Opaque cursor from a previous page response.',
};
const limitParam = {
  in: 'query',
  name: 'limit',
  schema: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
};
const idempotencyHeader = {
  in: 'header',
  name: 'Idempotency-Key',
  schema: { type: 'string', maxLength: 255 },
  description:
    'Optional retry-safety token. The same key + same body returns the cached response; reusing a key with a different body is 409.',
};

export const openapiSpec = {
  openapi: '3.1.0',
  info: {
    title: 'LA Mattress ERP API',
    version: '1.0.0',
    description:
      'Public REST API for LA Mattress ERP. Authenticate with `Authorization: Bearer jet_live_…` (or `jet_test_…`). The key implies the business; you do not need `X-Business-Id`. Mutating endpoints accept an `Idempotency-Key` header for retry safety. List endpoints return `{ data, nextCursor }`; round-trip the cursor to fetch the next page.',
    contact: { name: 'LA Mattress ERP', url: 'https://jetnine.example' },
  },
  servers: [{ url: '/', description: 'Same origin as your dashboard' }],
  security: [{ bearerAuth: [] }],
  tags: [
    { name: 'Sales', description: 'POS sales: create, list, refund.' },
    { name: 'Customers', description: 'Customer directory.' },
    { name: 'Products', description: 'Catalog browse + lookup.' },
    { name: 'Inventory', description: 'On-hand levels + movement ledger.' },
  ],
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'jet_<env>_<48hex>',
        description:
          'Mint a key at /settings/api-keys. The full secret is shown exactly once at creation.',
      },
    },
    schemas: {
      Error: ErrorObject,
      Sale: {
        type: 'object',
        required: ['id', 'number', 'status', 'totalCents', 'locationId', 'createdAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          number: { type: 'string', example: 'POS-2026-001234' },
          status: {
            type: 'string',
            enum: ['draft', 'completed', 'partially_refunded', 'refunded', 'voided'],
          },
          totalCents: { type: 'integer', minimum: 0 },
          customerId: { type: 'string', format: 'uuid', nullable: true },
          associateUserId: { type: 'string', format: 'uuid', nullable: true },
          locationId: { type: 'string', format: 'uuid' },
          completedAt: { type: 'string', format: 'date-time', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SaleDetail: {
        allOf: [
          { $ref: '#/components/schemas/Sale' },
          {
            type: 'object',
            properties: {
              subtotalCents: { type: 'integer' },
              discountCents: { type: 'integer' },
              taxCents: { type: 'integer' },
              notes: { type: 'string', nullable: true },
              lines: { type: 'array', items: { $ref: '#/components/schemas/SaleLine' } },
              payments: { type: 'array', items: { $ref: '#/components/schemas/Payment' } },
              refunds: { type: 'array', items: { $ref: '#/components/schemas/Refund' } },
            },
          },
        ],
      },
      SaleLine: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          variantId: { type: 'string', format: 'uuid', nullable: true },
          description: { type: 'string' },
          quantity: { type: 'integer', minimum: 1 },
          unitPriceCents: { type: 'integer' },
          discountCents: { type: 'integer' },
          totalCents: { type: 'integer' },
          refundedQuantity: { type: 'integer' },
        },
      },
      Payment: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          method: { type: 'string', enum: ['cash', 'card'] },
          amountCents: { type: 'integer' },
          status: { type: 'string' },
          processor: { type: 'string', nullable: true },
          processorRef: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      Refund: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          amountCents: { type: 'integer' },
          reason: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      CreateSaleBody: {
        type: 'object',
        required: ['locationId', 'lines', 'payments'],
        properties: {
          locationId: { type: 'string', format: 'uuid' },
          customerId: { type: 'string', format: 'uuid', nullable: true },
          notes: { type: 'string', nullable: true },
          lines: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['variantId', 'quantity'],
              properties: {
                variantId: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1 },
                unitPriceCents: { type: 'integer', description: 'Override; defaults to variant.' },
                lineDiscountCents: { type: 'integer', minimum: 0 },
              },
            },
          },
          orderDiscountCents: { type: 'integer', minimum: 0 },
          discountCode: {
            type: 'string',
            description: 'Mutually exclusive with orderDiscountCents.',
          },
          payments: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['method', 'amountCents'],
              properties: {
                method: { type: 'string', enum: ['cash', 'card', 'gift_card'] },
                amountCents: { type: 'integer', minimum: 0 },
                processorRef: { type: 'string' },
                cardBrand: {
                  type: 'string',
                  enum: ['visa', 'mastercard', 'amex', 'discover', 'jcb', 'diners', 'other'],
                  description: 'Card tenders only: the brand, for per-store tender breakdowns.',
                },
                stripePaymentMethodId: { type: 'string' },
              },
            },
          },
        },
      },
      RefundBody: {
        type: 'object',
        required: ['lines'],
        properties: {
          reason: { type: 'string', nullable: true },
          lines: {
            type: 'array',
            minItems: 1,
            items: {
              type: 'object',
              required: ['saleLineId', 'quantity'],
              properties: {
                saleLineId: { type: 'string', format: 'uuid' },
                quantity: { type: 'integer', minimum: 1 },
              },
            },
          },
        },
      },
      Customer: {
        type: 'object',
        required: ['id', 'createdAt', 'updatedAt'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          email: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
          addressesJson: { nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      CustomerBody: {
        type: 'object',
        description: 'At least one of firstName, lastName, email, phone is required.',
        properties: {
          email: { type: 'string', nullable: true },
          phone: { type: 'string', nullable: true },
          firstName: { type: 'string', nullable: true },
          lastName: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
          addressesJson: { nullable: true },
        },
      },
      Product: {
        type: 'object',
        required: ['id', 'name', 'isActive'],
        properties: {
          id: { type: 'string', format: 'uuid' },
          sku: { type: 'string', nullable: true },
          name: { type: 'string' },
          isActive: {
            type: 'boolean',
            description:
              'The selling switch. Inactive products are omitted unless includeInactive.',
          },
          purchaseStatus: {
            type: 'string',
            enum: [...PRODUCT_PURCHASE_STATUSES],
            description: 'Whether the buyer may still order it; independent of isActive.',
          },
          brandName: { type: 'string', nullable: true },
          vendorName: {
            type: 'string',
            nullable: true,
            description: "The primary variant's preferred vendor.",
          },
          vendorModel: {
            type: 'string',
            nullable: true,
            description: "The primary variant's vendor SKU.",
          },
          group: {
            type: 'string',
            nullable: true,
            description: "STORIS size / product group, from the variant's attributes.",
          },
          priceCents: { type: 'integer', nullable: true },
          costCents: {
            type: 'integer',
            nullable: true,
            description: 'Only returned if your key has products.cost.view scope.',
          },
          onHand: { type: 'integer', description: 'Units on hand, summed over locations.' },
          available: {
            type: 'integer',
            description: 'Σ max(0, on hand − reserved − floor sample) per location.',
          },
          netOnPo: {
            type: 'integer',
            description:
              'Σ (ordered − accepted − rejected) over live, non-direct-ship purchase orders that are ordered or partially received.',
          },
          asIsOnHand: { type: 'integer', description: 'As-is pieces still in review.' },
          asIsAvailable: { type: 'integer' },
          asIsNonSellable: {
            type: 'integer',
            description: 'As-is pieces in condition damaged or parts.',
          },
        },
      },
      ProductDetail: {
        allOf: [
          { $ref: '#/components/schemas/Product' },
          {
            type: 'object',
            properties: {
              description: { type: 'string', nullable: true },
              categoryId: { type: 'string', format: 'uuid', nullable: true },
              taxClassId: { type: 'string', format: 'uuid', nullable: true },
              variants: { type: 'array', items: { $ref: '#/components/schemas/Variant' } },
              images: { type: 'array', items: { $ref: '#/components/schemas/ProductImage' } },
              secondDescription: { type: 'string', nullable: true },
              categoryName: { type: 'string', nullable: true },
              categoryPath: {
                type: 'string',
                nullable: true,
                description: 'Full nested category name, e.g. "Mattresses › Hybrid"',
              },
              serialTracked: { type: 'boolean' },
              boxesPerProduct: { type: 'integer' },
              logisticalCartonQty: { type: 'integer' },
              purchaseCartonQty: { type: 'integer' },
              logisticalCartonTransfers: { type: 'boolean' },
              stock: {
                type: 'object',
                description: 'Quantities in total and per (variant, location).',
                properties: {
                  totals: { $ref: '#/components/schemas/StockTotals' },
                  byLocation: {
                    type: 'array',
                    items: { $ref: '#/components/schemas/LocationStock' },
                  },
                },
              },
              createdAt: { type: 'string', format: 'date-time' },
              updatedAt: { type: 'string', format: 'date-time' },
            },
          },
        ],
      },
      StockTotals: {
        type: 'object',
        properties: {
          onHand: { type: 'integer' },
          reserved: { type: 'integer' },
          floorSample: { type: 'integer' },
          available: { type: 'integer' },
          netOnPo: { type: 'integer' },
          totalPo: { type: 'integer' },
          asIsOnHand: { type: 'integer' },
          asIsAvailable: { type: 'integer' },
          asIsNonSellable: { type: 'integer' },
          layawayReserved: { type: 'integer' },
        },
      },
      LocationStock: {
        allOf: [
          { $ref: '#/components/schemas/StockTotals' },
          {
            type: 'object',
            properties: {
              variantId: { type: 'string', format: 'uuid' },
              variantSku: { type: 'string', nullable: true },
              variantActive: { type: 'boolean' },
              locationId: { type: 'string', format: 'uuid' },
              locationName: { type: 'string' },
              locationActive: { type: 'boolean' },
              storageBinId: { type: 'string', format: 'uuid', nullable: true },
              storageBinCode: { type: 'string', nullable: true },
            },
          },
        ],
      },
      Variant: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          sku: { type: 'string', nullable: true },
          name: { type: 'string', nullable: true },
          barcode: { type: 'string', nullable: true },
          priceCents: { type: 'integer' },
          costCents: {
            type: 'integer',
            nullable: true,
            description: 'Only returned if your key has products.cost.view scope.',
          },
          attributesJson: { nullable: true },
          isActive: { type: 'boolean' },
        },
      },
      ProductImage: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          storageKey: { type: 'string' },
          altText: { type: 'string', nullable: true },
          position: { type: 'integer' },
        },
      },
      InventoryLevel: {
        type: 'object',
        properties: {
          variantId: { type: 'string', format: 'uuid' },
          locationId: { type: 'string', format: 'uuid' },
          productId: { type: 'string', format: 'uuid' },
          productName: { type: 'string' },
          variantSku: { type: 'string', nullable: true },
          variantName: { type: 'string', nullable: true },
          variantBarcode: { type: 'string', nullable: true },
          onHand: { type: 'integer' },
          reserved: { type: 'integer' },
          available: { type: 'integer' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      InventoryMovement: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          variantId: { type: 'string', format: 'uuid' },
          locationId: { type: 'string', format: 'uuid' },
          delta: { type: 'integer' },
          reason: { type: 'string' },
          referenceType: { type: 'string', nullable: true },
          referenceId: { type: 'string', nullable: true },
          actorUserId: { type: 'string', format: 'uuid', nullable: true },
          actorEmail: { type: 'string', nullable: true },
          notes: { type: 'string', nullable: true },
          createdAt: { type: 'string', format: 'date-time' },
        },
      },
      SaleListPage: PageEnvelope('#/components/schemas/Sale'),
      CustomerListPage: PageEnvelope('#/components/schemas/Customer'),
      ProductListPage: PageEnvelope('#/components/schemas/Product'),
      InventoryMovementListPage: PageEnvelope('#/components/schemas/InventoryMovement'),
    },
    responses: {
      Unauthorized: {
        description: 'Missing or invalid bearer token.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Forbidden: {
        description: "API key doesn't carry the required scope.",
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      NotFound: {
        description: 'Resource does not exist or is not visible to your tenant.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      Conflict: {
        description: 'Idempotency-Key reused with a different body, or a uniqueness violation.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
      BadRequest: {
        description: 'Validation error.',
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      },
    },
  },
  paths: {
    '/v1/sales': {
      get: {
        tags: ['Sales'],
        summary: 'List sales (newest first)',
        operationId: 'listSales',
        parameters: [limitParam, cursorParam],
        responses: {
          '200': {
            description: 'A page of sales.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SaleListPage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Sales'],
        summary: 'Create a sale',
        operationId: 'createSale',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CreateSaleBody' } },
          },
        },
        responses: {
          '201': {
            description: 'Sale created.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SaleDetail' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '409': { $ref: '#/components/responses/Conflict' },
        },
      },
    },
    '/v1/sales/{id}': {
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        tags: ['Sales'],
        summary: 'Get sale detail',
        operationId: 'getSale',
        responses: {
          '200': {
            description: 'Sale with lines, payments, refunds.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SaleDetail' } },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/sales/{id}/refund': {
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      post: {
        tags: ['Sales'],
        summary: 'Refund (partial or full) a completed sale',
        operationId: 'refundSale',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: { 'application/json': { schema: { $ref: '#/components/schemas/RefundBody' } } },
        },
        responses: {
          '201': {
            description: 'Refund recorded.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/SaleDetail' } },
            },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/customers': {
      get: {
        tags: ['Customers'],
        summary: 'List customers',
        operationId: 'listCustomers',
        parameters: [
          {
            in: 'query',
            name: 'q',
            schema: { type: 'string' },
            description:
              'Full-text search across name/email/phone. When set, the response is single-page (nextCursor: null).',
          },
          limitParam,
          cursorParam,
        ],
        responses: {
          '200': {
            description: 'A page of customers.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CustomerListPage' },
              },
            },
          },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
      post: {
        tags: ['Customers'],
        summary: 'Create a customer',
        operationId: 'createCustomer',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CustomerBody' } },
          },
        },
        responses: {
          '201': {
            description: 'Customer created.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } },
          },
          '400': { $ref: '#/components/responses/BadRequest' },
          '401': { $ref: '#/components/responses/Unauthorized' },
          '403': { $ref: '#/components/responses/Forbidden' },
        },
      },
    },
    '/v1/customers/{id}': {
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        tags: ['Customers'],
        summary: 'Get a customer',
        operationId: 'getCustomer',
        responses: {
          '200': {
            description: 'Customer with `recentSales`.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      patch: {
        tags: ['Customers'],
        summary: 'Update a customer',
        operationId: 'updateCustomer',
        parameters: [idempotencyHeader],
        requestBody: {
          required: true,
          content: {
            'application/json': { schema: { $ref: '#/components/schemas/CustomerBody' } },
          },
        },
        responses: {
          '200': {
            description: 'Updated customer.',
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Customer' } } },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
      delete: {
        tags: ['Customers'],
        summary: 'Delete a customer (sales references survive via SET NULL)',
        operationId: 'deleteCustomer',
        parameters: [idempotencyHeader],
        responses: {
          '200': {
            description: '`{ deleted: true }`',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: { deleted: { type: 'boolean', enum: [true] } },
                },
              },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/products': {
      get: {
        tags: ['Products'],
        summary: 'List products',
        operationId: 'listProducts',
        parameters: [
          {
            in: 'query',
            name: 'q',
            schema: { type: 'string' },
            description: 'Full-text search across products + variants. Single page when set.',
          },
          {
            in: 'query',
            name: 'categoryId',
            schema: { type: 'string', format: 'uuid' },
          },
          {
            in: 'query',
            name: 'locationId',
            schema: { type: 'string', format: 'uuid' },
            description:
              'Narrow every stock column (onHand, available, netOnPo, as-is) to one location. Omit to sum across all of them.',
          },
          {
            in: 'query',
            name: 'includeInactive',
            schema: { type: 'string', enum: ['1', 'true'] },
            description:
              'By default only active products are listed. Set to 1 to include deactivated ones (they keep every document they appear on).',
          },
          limitParam,
          cursorParam,
        ],
        responses: {
          '200': {
            description: 'A page of products. Active products only unless includeInactive is set.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ProductListPage' },
              },
            },
          },
        },
      },
    },
    '/v1/products/{id}': {
      parameters: [
        { in: 'path', name: 'id', required: true, schema: { type: 'string', format: 'uuid' } },
      ],
      get: {
        tags: ['Products'],
        summary: 'Get product detail (with variants + images)',
        operationId: 'getProduct',
        responses: {
          '200': {
            description: 'Product detail.',
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/ProductDetail' } },
            },
          },
          '404': { $ref: '#/components/responses/NotFound' },
        },
      },
    },
    '/v1/inventory/levels': {
      get: {
        tags: ['Inventory'],
        summary: 'On-hand inventory by location',
        operationId: 'listInventoryLevels',
        parameters: [
          { in: 'query', name: 'locationId', schema: { type: 'string', format: 'uuid' } },
        ],
        responses: {
          '200': {
            description: 'Levels (not paginated; bounded per business).',
            content: {
              'application/json': {
                schema: {
                  type: 'array',
                  items: { $ref: '#/components/schemas/InventoryLevel' },
                },
              },
            },
          },
        },
      },
    },
    '/v1/inventory/movements': {
      get: {
        tags: ['Inventory'],
        summary: 'Movement ledger (newest first)',
        operationId: 'listInventoryMovements',
        parameters: [
          { in: 'query', name: 'variantId', schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'locationId', schema: { type: 'string', format: 'uuid' } },
          { in: 'query', name: 'since', schema: { type: 'string', format: 'date-time' } },
          { in: 'query', name: 'until', schema: { type: 'string', format: 'date-time' } },
          limitParam,
          cursorParam,
        ],
        responses: {
          '200': {
            description: 'A page of movements.',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/InventoryMovementListPage' },
              },
            },
          },
        },
      },
    },
  },
} as const;

export type OpenApiSpec = typeof openapiSpec;
