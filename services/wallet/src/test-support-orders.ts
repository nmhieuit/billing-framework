import { randomUUID } from 'node:crypto';
import type { OrderReadyForPaymentV1 } from '@billing/contracts';
import { waitFor, type BrokerAccess } from '@billing/testing';
import amqp, { type ChannelModel, type ConfirmChannel } from 'amqplib';

export interface OrderResult {
  type: string | undefined;
  messageId: string | undefined;
  body: Record<string, unknown>;
}

const connect = (access: BrokerAccess): Promise<ChannelModel> =>
  amqp.connect({
    protocol: 'amqp',
    hostname: access.host,
    port: access.port,
    username: access.user,
    password: access.password,
    vhost: access.vhost,
  });

export async function queueDepth(access: BrokerAccess, queue: string): Promise<number> {
  const connection = await connect(access);
  try {
    const channel = await connection.createChannel();
    return (await channel.checkQueue(queue)).messageCount;
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Đọc (không ack) message đầu của một queue để kiểm tra nội dung và header. */
export async function peekQueue(
  access: BrokerAccess,
  queue: string,
): Promise<{
  body: string;
  headers: Record<string, unknown>;
  messageId: string | undefined;
} | null> {
  const connection = await connect(access);
  try {
    const channel = await connection.createChannel();
    const message = await channel.get(queue, { noAck: true });
    if (message === false) return null;
    return {
      body: message.content.toString('utf8'),
      headers: message.properties.headers ?? {},
      messageId: message.properties.messageId,
    };
  } finally {
    await connection.close().catch(() => undefined);
  }
}

/** Đóng vai ecommerce: publish OrderReadyForPaymentV1 vào orders.events và đọc kết quả từ billing.events. */
export class OrdersSimulator {
  readonly results: OrderResult[] = [];

  private constructor(
    private readonly connection: ChannelModel,
    private readonly channel: ConfirmChannel,
  ) {}

  static async connect(
    access: BrokerAccess,
    options: { bindResults?: boolean } = {},
  ): Promise<OrdersSimulator> {
    const connection = await connect(access);
    const channel = await connection.createConfirmChannel();
    const simulator = new OrdersSimulator(connection, channel);
    if (options.bindResults ?? true) await simulator.bindResults();
    return simulator;
  }

  /** Ecommerce khai báo queue của họ (tiền tố `ecommerce.`) gắn vào billing.events rồi bắt đầu đọc. */
  async bindResults(): Promise<void> {
    await this.channel.assertQueue('ecommerce.order-results', { durable: true });
    for (const key of ['order-paid.v1', 'order-payment-failed.v1']) {
      await this.channel.bindQueue('ecommerce.order-results', 'billing.events', key);
    }
    await this.channel.consume('ecommerce.order-results', (message) => {
      if (message === null) return;
      this.results.push({
        type: message.properties.type,
        messageId: message.properties.messageId,
        body: JSON.parse(message.content.toString('utf8')) as Record<string, unknown>,
      });
      this.channel.ack(message);
    });
  }

  ready(overrides: Partial<OrderReadyForPaymentV1> = {}): OrderReadyForPaymentV1 {
    return {
      eventId: randomUUID(),
      occurredAtUtc: new Date().toISOString(),
      tenantId: 'acme',
      correlationId: randomUUID(),
      orderId: randomUUID(),
      customerId: 'customer',
      amount: 50000,
      currency: 'VND',
      ...overrides,
    };
  }

  publish(event: OrderReadyForPaymentV1): Promise<void> {
    return this.publishRaw(JSON.stringify(event), event.eventId);
  }

  publishRaw(
    body: string,
    messageId: string = randomUUID(),
    routingKey = 'order-ready-for-payment.v1',
  ): Promise<void> {
    return new Promise((resolve, reject) =>
      this.channel.publish(
        'orders.events',
        routingKey,
        Buffer.from(body),
        {
          persistent: true,
          contentType: 'application/json',
          messageId,
          type: 'OrderReadyForPaymentV1',
          headers: { 'x-correlation-id': 'simulator' },
        },
        (error) => (error ? reject(error) : resolve()),
      ),
    );
  }

  resultsFor(orderId: string): OrderResult[] {
    return this.results.filter((result) => result.body.orderId === orderId);
  }

  async waitForResults(count: number, timeoutMs = 15_000): Promise<void> {
    await waitFor(() => this.results.length >= count, { timeoutMs, intervalMs: 50 });
  }

  async close(): Promise<void> {
    await this.connection.close().catch(() => undefined);
  }
}
