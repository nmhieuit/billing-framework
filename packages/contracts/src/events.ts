import type { FromSchema } from 'json-schema-to-ts';

const moneyProperties = {
  amount: {
    type: 'integer',
    minimum: 1,
    description: 'Số nguyên minor unit (VND: đồng, USD: cent)',
  },
  currency: { type: 'string', enum: ['VND', 'USD'] },
} as const;

export const orderReadyForPaymentV1 = {
  $id: 'urn:billing:schema:orders.order-ready-for-payment:v1',
  type: 'object',
  required: ['orderId', 'customerId', 'amount', 'currency'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    customerId: { type: 'string', minLength: 1 },
    ...moneyProperties,
  },
} as const;

export const orderPaidV1 = {
  $id: 'urn:billing:schema:billing.order-paid:v1',
  type: 'object',
  required: ['orderId', 'walletTransactionId', 'paidAt'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    walletTransactionId: { type: 'string', minLength: 1 },
    paidAt: { type: 'string', format: 'date-time' },
  },
} as const;

export const orderPaymentFailedV1 = {
  $id: 'urn:billing:schema:billing.order-payment-failed:v1',
  type: 'object',
  required: ['orderId', 'reason'],
  properties: {
    orderId: { type: 'string', minLength: 1 },
    reason: {
      type: 'string',
      enum: ['INSUFFICIENT_FUNDS', 'WALLET_NOT_FOUND', 'CURRENCY_MISMATCH', 'CONFLICT'],
    },
  },
} as const;

export const eventSchemas = {
  'orders.order-ready-for-payment.v1': orderReadyForPaymentV1,
  'billing.order-paid.v1': orderPaidV1,
  'billing.order-payment-failed.v1': orderPaymentFailedV1,
} as const;

export type EventType = keyof typeof eventSchemas;

export type OrderReadyForPaymentV1 = FromSchema<typeof orderReadyForPaymentV1>;
export type OrderPaidV1 = FromSchema<typeof orderPaidV1>;
export type OrderPaymentFailedV1 = FromSchema<typeof orderPaymentFailedV1>;
