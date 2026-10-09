import type { FromSchema } from 'json-schema-to-ts';

export const envelopeSchema = {
  $id: 'urn:billing:schema:envelope:v1',
  type: 'object',
  required: [
    'messageId',
    'type',
    'occurredAt',
    'correlationId',
    'causationId',
    'tenantId',
    'data',
  ],
  properties: {
    messageId: { type: 'string', format: 'uuid' },
    type: { type: 'string', pattern: '^(orders|billing)\\.[a-z][a-z-]*\\.v[0-9]+$' },
    occurredAt: { type: 'string', format: 'date-time' },
    correlationId: { type: 'string', format: 'uuid' },
    causationId: { type: 'string', format: 'uuid' },
    tenantId: { type: 'string', minLength: 1 },
    data: { type: 'object' },
  },
} as const;

type EnvelopeBase = FromSchema<typeof envelopeSchema>;

export type Envelope<TData = unknown> = Omit<EnvelopeBase, 'data'> & { data: TData };
