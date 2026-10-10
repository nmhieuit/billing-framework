import { describe, expect, it } from 'vitest';
import {
  DLQ_ROUTING_KEY,
  deadLetterQueueName,
  declareConsumerTopology,
  retryQueueName,
  retryRoutingKey,
  type ConsumerTopology,
} from './topology.js';

const topology: ConsumerTopology = {
  queue: 'wallet.order-payments',
  workExchange: 'wallet.work',
  workRoutingKey: 'order-payments',
  retryExchange: 'wallet.retry',
  retryDelaysSeconds: [5, 30],
  bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
};

describe('topology names', () => {
  it('derives queue and routing key names', () => {
    expect(retryQueueName('wallet.order-payments', 30)).toBe('wallet.order-payments.retry.30');
    expect(retryRoutingKey(30)).toBe('retry.30');
    expect(deadLetterQueueName('wallet.order-payments')).toBe('wallet.order-payments.dlq');
    expect(DLQ_ROUTING_KEY).toBe('dlq');
  });
});

describe('declareConsumerTopology', () => {
  it('declares work/retry exchanges, queues with TTL dead-lettering to the work exchange, and never touches the default exchange', async () => {
    const calls: Array<[string, ...unknown[]]> = [];
    const record =
      (name: string) =>
      async (...args: unknown[]) => {
        calls.push([name, ...args]);
        return { queue: '', messageCount: 0, consumerCount: 0 };
      };
    const channel = {
      checkExchange: record('checkExchange'),
      assertExchange: record('assertExchange'),
      assertQueue: record('assertQueue'),
      bindQueue: record('bindQueue'),
    };

    await declareConsumerTopology(channel as never, topology);

    expect(calls).toEqual([
      ['checkExchange', 'orders.events'],
      ['assertExchange', 'wallet.work', 'direct', { durable: true }],
      ['assertExchange', 'wallet.retry', 'direct', { durable: true }],
      ['assertQueue', 'wallet.order-payments', { durable: true }],
      ['bindQueue', 'wallet.order-payments', 'wallet.work', 'order-payments'],
      ['bindQueue', 'wallet.order-payments', 'orders.events', 'order-ready-for-payment.v1'],
      [
        'assertQueue',
        'wallet.order-payments.retry.5',
        {
          durable: true,
          arguments: {
            'x-message-ttl': 5000,
            'x-dead-letter-exchange': 'wallet.work',
            'x-dead-letter-routing-key': 'order-payments',
          },
        },
      ],
      ['bindQueue', 'wallet.order-payments.retry.5', 'wallet.retry', 'retry.5'],
      [
        'assertQueue',
        'wallet.order-payments.retry.30',
        {
          durable: true,
          arguments: {
            'x-message-ttl': 30000,
            'x-dead-letter-exchange': 'wallet.work',
            'x-dead-letter-routing-key': 'order-payments',
          },
        },
      ],
      ['bindQueue', 'wallet.order-payments.retry.30', 'wallet.retry', 'retry.30'],
      ['assertQueue', 'wallet.order-payments.dlq', { durable: true }],
      ['bindQueue', 'wallet.order-payments.dlq', 'wallet.retry', 'dlq'],
    ]);
    expect(JSON.stringify(calls)).not.toContain('amq.default');
    expect(calls.some(([, , exchange]) => exchange === '')).toBe(false);
  });
});
