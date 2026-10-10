import type { Channel } from 'amqplib';

/**
 * Quy tắc: mỗi cặp (`workExchange`, `retryExchange`) chỉ dành cho MỘT queue consumer. Routing key retry/DLQ
 * (`retry.<giây>`, `dlq`) và `workRoutingKey` không gắn với tên queue, nên hai queue dùng chung exchange sẽ nhận
 * bản sao message retry/DLQ của nhau. `BrokerClient.consume` từ chối cấu hình vi phạm.
 */
export interface ConsumerTopology {
  queue: string;
  workExchange: string;
  workRoutingKey: string;
  retryExchange: string;
  retryDelaysSeconds: readonly number[];
  bindings: ReadonlyArray<{ exchange: string; routingKey: string }>;
}

export const DLQ_ROUTING_KEY = 'dlq';

export const retryQueueName = (queue: string, seconds: number): string =>
  `${queue}.retry.${seconds}`;
export const retryRoutingKey = (seconds: number): string => `retry.${seconds}`;
export const deadLetterQueueName = (queue: string): string => `${queue}.dlq`;

/**
 * Khai báo idempotent: exchange `work`/`retry` (direct), queue chính, các queue retry (TTL, dead-letter về `work`) và DLQ.
 * Exchange nguồn trong `bindings` chỉ được kiểm tra (passive) vì do script init tạo; nếu thiếu, broker đóng channel
 * với 404 — nên chạy hàm này trên một channel dùng một lần. Không bao giờ dùng default exchange (`amq.default`).
 */
export async function declareConsumerTopology(
  channel: Channel,
  topology: ConsumerTopology,
): Promise<void> {
  for (const exchange of new Set(topology.bindings.map((binding) => binding.exchange))) {
    await channel.checkExchange(exchange);
  }
  await channel.assertExchange(topology.workExchange, 'direct', { durable: true });
  await channel.assertExchange(topology.retryExchange, 'direct', { durable: true });

  await channel.assertQueue(topology.queue, { durable: true });
  await channel.bindQueue(topology.queue, topology.workExchange, topology.workRoutingKey);
  for (const binding of topology.bindings) {
    await channel.bindQueue(topology.queue, binding.exchange, binding.routingKey);
  }

  for (const seconds of topology.retryDelaysSeconds) {
    const name = retryQueueName(topology.queue, seconds);
    await channel.assertQueue(name, {
      durable: true,
      arguments: {
        'x-message-ttl': seconds * 1000,
        'x-dead-letter-exchange': topology.workExchange,
        'x-dead-letter-routing-key': topology.workRoutingKey,
      },
    });
    await channel.bindQueue(name, topology.retryExchange, retryRoutingKey(seconds));
  }

  const dead = deadLetterQueueName(topology.queue);
  await channel.assertQueue(dead, { durable: true });
  await channel.bindQueue(dead, topology.retryExchange, DLQ_ROUTING_KEY);
}
