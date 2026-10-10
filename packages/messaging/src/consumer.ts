import { randomUUID } from 'node:crypto';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { ConfirmPublisher } from './publisher.js';
import { DLQ_ROUTING_KEY, retryRoutingKey, type ConsumerTopology } from './topology.js';
import type { BrokerLogger, HandlerResult, IncomingMessage, MessageHandler } from './types.js';

export interface ConsumerSpec {
  topology: ConsumerTopology;
  prefetch: number;
  handler: MessageHandler;
}

export interface RunningConsumer {
  /** Hủy đăng ký rồi chờ mọi handler đang chạy xong (kể cả ack). */
  stop(): Promise<void>;
}

const RETRY_COUNT = 'x-retry-count';

/** Header do broker thêm khi dead-letter; không chép sang bản republish. */
const isBrokerHeader = (name: string): boolean =>
  name === 'x-death' || name.startsWith('x-first-death') || name.startsWith('x-last-death');

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export async function startConsumer(options: {
  channel: Channel;
  publisher: ConfirmPublisher;
  spec: ConsumerSpec;
  log: BrokerLogger;
}): Promise<RunningConsumer> {
  const { channel, publisher, spec, log } = options;
  const { topology } = spec;
  const inflight = new Set<Promise<void>>();

  const forward = async (
    raw: ConsumeMessage,
    routingKey: string,
    extra: Record<string, unknown>,
  ): Promise<void> => {
    const headers = Object.fromEntries(
      Object.entries(raw.properties.headers ?? {}).filter(([name]) => !isBrokerHeader(name)),
    );
    const result = await publisher.publish(
      {
        exchange: topology.retryExchange,
        routingKey,
        messageId: raw.properties.messageId ?? randomUUID(),
        type: raw.properties.type ?? 'unknown',
        correlationId: String(raw.properties.headers?.['x-correlation-id'] ?? ''),
        body: raw.content.toString('utf8'),
      },
      { ...headers, ...extra },
    );
    if (result.kind !== 'delivered') {
      throw new Error(
        `could not forward message (${result.kind === 'failed' ? result.error : 'unroutable'})`,
      );
    }
  };

  const deadLetter = async (raw: ConsumeMessage, reason: string): Promise<void> => {
    await forward(raw, DLQ_ROUTING_KEY, { 'x-dead-letter-reason': reason });
    channel.ack(raw);
  };

  const retry = async (raw: ConsumeMessage, retryCount: number, reason: string): Promise<void> => {
    const delay = topology.retryDelaysSeconds[retryCount];
    if (delay === undefined) {
      await deadLetter(raw, `retries exhausted: ${reason}`);
      return;
    }
    await forward(raw, retryRoutingKey(delay), {
      [RETRY_COUNT]: retryCount + 1,
      'x-last-error': reason,
    });
    channel.ack(raw);
  };

  const process = async (raw: ConsumeMessage): Promise<void> => {
    const rawCount = Number(raw.properties.headers?.[RETRY_COUNT] ?? 0);
    const retryCount = Number.isInteger(rawCount) && rawCount >= 0 ? rawCount : 0;
    const incoming: IncomingMessage = {
      body: raw.content,
      messageId: raw.properties.messageId,
      type: raw.properties.type,
      redelivered: raw.fields.redelivered,
      retryCount,
      headers: raw.properties.headers ?? {},
    };

    let result: HandlerResult;
    try {
      result = await spec.handler(incoming);
    } catch (error) {
      result = { action: 'retry', reason: `handler threw: ${errorText(error)}` };
    }

    try {
      if (result.action === 'ack') channel.ack(raw);
      else if (result.action === 'retry') await retry(raw, retryCount, result.reason);
      else await deadLetter(raw, result.reason);
    } catch (error) {
      // Kênh đã đóng hoặc không republish được: trả message về queue; nếu kênh chết thì broker tự giao lại.
      log.error(
        { err: errorText(error), messageId: raw.properties.messageId },
        'could not settle message; requeueing',
      );
      try {
        channel.nack(raw, false, true);
      } catch {
        // Kênh đã chết: message sẽ được broker giao lại khi consumer kế tiếp kết nối.
      }
    }
  };

  await channel.prefetch(spec.prefetch);
  const { consumerTag } = await channel.consume(
    topology.queue,
    (raw) => {
      if (raw === null) return;
      const task: Promise<void> = process(raw).finally(() => {
        inflight.delete(task);
      });
      inflight.add(task);
    },
    { noAck: false },
  );

  return {
    async stop() {
      try {
        await channel.cancel(consumerTag);
      } catch {
        // Kênh đã đóng (mất kết nối): không còn gì để hủy.
      }
      while (inflight.size > 0) await Promise.allSettled([...inflight]);
    },
  };
}
