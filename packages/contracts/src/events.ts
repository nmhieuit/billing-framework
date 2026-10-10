import type { FromSchema } from 'json-schema-to-ts';

/** Trường chung của mọi event: quy ước event của ecommerce (JSON phẳng, không envelope). */
const commonProperties = {
  eventId: { type: 'string', format: 'uuid' },
  occurredAtUtc: { type: 'string', format: 'date-time' },
  tenantId: { type: 'string', minLength: 1, maxLength: 64 },
  correlationId: { type: 'string', minLength: 1, maxLength: 100 },
} as const;

const moneyProperties = {
  amount: {
    type: 'integer',
    minimum: 1,
    maximum: 9007199254740991,
    description: 'Số nguyên minor unit (VND: đồng, USD: cent)',
  },
  currency: { type: 'string', enum: ['VND', 'USD'] },
} as const;

export const orderReadyForPaymentV1 = {
  $id: 'urn:billing:schema:OrderReadyForPayment:v1',
  type: 'object',
  required: [
    'eventId',
    'occurredAtUtc',
    'tenantId',
    'correlationId',
    'orderId',
    'customerId',
    'amount',
    'currency',
  ],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    customerId: { type: 'string', minLength: 1, maxLength: 64 },
    ...moneyProperties,
  },
} as const;

export const orderPaidV1 = {
  $id: 'urn:billing:schema:OrderPaid:v1',
  type: 'object',
  required: [
    'eventId',
    'occurredAtUtc',
    'tenantId',
    'correlationId',
    'orderId',
    'walletTransactionId',
    'amount',
    'currency',
    'paidAtUtc',
  ],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    walletTransactionId: { type: 'string', minLength: 1 },
    ...moneyProperties,
    paidAtUtc: { type: 'string', format: 'date-time' },
  },
} as const;

export const orderPaymentFailedV1 = {
  $id: 'urn:billing:schema:OrderPaymentFailed:v1',
  type: 'object',
  required: ['eventId', 'occurredAtUtc', 'tenantId', 'correlationId', 'orderId', 'reason'],
  properties: {
    ...commonProperties,
    orderId: { type: 'string', format: 'uuid' },
    reason: {
      type: 'string',
      enum: ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'],
    },
  },
} as const;

/** Mỗi event: schema, routing key (khóa định tuyến trên exchange) và tên file schema phát hành. */
export const eventCatalog = {
  OrderReadyForPaymentV1: {
    schema: orderReadyForPaymentV1,
    routingKey: 'order-ready-for-payment.v1',
    schemaFile: 'OrderReadyForPayment.v1.schema.json',
  },
  OrderPaidV1: {
    schema: orderPaidV1,
    routingKey: 'order-paid.v1',
    schemaFile: 'OrderPaid.v1.schema.json',
  },
  OrderPaymentFailedV1: {
    schema: orderPaymentFailedV1,
    routingKey: 'order-payment-failed.v1',
    schemaFile: 'OrderPaymentFailed.v1.schema.json',
  },
} as const;

export type EventName = keyof typeof eventCatalog;

export type OrderReadyForPaymentV1 = FromSchema<typeof orderReadyForPaymentV1>;
export type OrderPaidV1 = FromSchema<typeof orderPaidV1>;
export type OrderPaymentFailedV1 = FromSchema<typeof orderPaymentFailedV1>;

export interface EventPayloads {
  OrderReadyForPaymentV1: OrderReadyForPaymentV1;
  OrderPaidV1: OrderPaidV1;
  OrderPaymentFailedV1: OrderPaymentFailedV1;
}
