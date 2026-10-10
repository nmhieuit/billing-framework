import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';
import type { BrokerAccess } from '@billing/testing';
import type { ConsumerTopology } from './topology.js';
import type { BrokerLogger } from './types.js';

export const silentLog: BrokerLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Topology dùng trong test: giống wallet nhưng bậc retry ngắn. */
export const testTopology = (retryDelaysSeconds: readonly number[] = [1, 2]): ConsumerTopology => ({
  queue: 'wallet.test-queue',
  workExchange: 'wallet.work',
  workRoutingKey: 'test',
  retryExchange: 'wallet.retry',
  retryDelaysSeconds,
  bindings: [{ exchange: 'orders.events', routingKey: 'order-ready-for-payment.v1' }],
});

export function open(access: BrokerAccess): Promise<ChannelModel> {
  return amqp.connect({
    protocol: 'amqp',
    hostname: access.host,
    port: access.port,
    username: access.user,
    password: access.password,
    vhost: access.vhost,
  });
}

/** Đóng vai ecommerce: publish vào orders.events bằng đúng user ecommerce_orders. */
export async function publishAsOrders(
  channel: ConfirmChannel,
  body: unknown,
  options: { messageId: string; routingKey?: string } = { messageId: 'e1' },
): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    channel.publish(
      'orders.events',
      options.routingKey ?? 'order-ready-for-payment.v1',
      Buffer.from(JSON.stringify(body)),
      {
        persistent: true,
        contentType: 'application/json',
        messageId: options.messageId,
        type: 'OrderReadyForPaymentV1',
        headers: { 'x-correlation-id': 'corr-1' },
      },
      (error) => (error ? reject(error) : resolve()),
    ),
  );
}
