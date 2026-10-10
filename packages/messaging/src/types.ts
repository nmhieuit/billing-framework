export interface BrokerConfig {
  host: string;
  port: number;
  vhost: string;
  user: string;
  password: string;
}

export interface BrokerLogger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface OutgoingMessage {
  exchange: string;
  routingKey: string;
  messageId: string;
  /** Tên event, ví dụ `OrderPaidV1` (thuộc tính AMQP `type`). */
  type: string;
  correlationId: string;
  /** JSON đã serialize. */
  body: string;
}

export type PublishResult =
  { kind: 'delivered' } | { kind: 'unroutable' } | { kind: 'failed'; error: string };

export interface IncomingMessage {
  body: Buffer;
  messageId: string | undefined;
  type: string | undefined;
  redelivered: boolean;
  /** Số lần đã retry qua các bậc backoff (header `x-retry-count`). */
  retryCount: number;
  headers: Record<string, unknown>;
}

export type HandlerResult =
  { action: 'ack' } | { action: 'retry'; reason: string } | { action: 'reject'; reason: string };

export type MessageHandler = (message: IncomingMessage) => Promise<HandlerResult>;
