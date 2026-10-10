import { connect, type Channel, type ChannelModel, type ConfirmChannel } from 'amqplib';
import { startConsumer, type ConsumerSpec, type RunningConsumer } from './consumer.js';
import { ConfirmPublisher } from './publisher.js';
import { declareConsumerTopology } from './topology.js';
import type { BrokerConfig, BrokerLogger } from './types.js';

interface Registration {
  spec: ConsumerSpec;
  running: RunningConsumer | undefined;
}

const RESTART_BASE_MS = 200;
const RESTART_MAX_MS = 5_000;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * Một kết nối tự phục hồi. Có hai tầng phục hồi:
 * - Mất kết nối: amqplib gọi lại `setup`, ta tạo lại confirm channel cho publisher, channel cho consumer và bật lại
 *   mọi consumer đã đăng ký (message chưa ack được broker giao lại với `redelivered = true`; publish trong lúc mất
 *   kết nối trả `failed` để bên gọi thử lại).
 * - Kết nối còn sống nhưng broker đóng một channel (lỗi 403/404, `consumer_timeout`...) hoặc hủy một consumer
 *   (queue bị xóa): ta tự mở lại channel / bật lại consumer đó với backoff 200 ms → 5 s.
 * Lỗi bật một consumer trong lúc phục hồi chỉ ảnh hưởng consumer đó (log + thử lại), không kéo publisher xuống.
 * Mọi thao tác thay đổi trạng thái được tuần tự hóa qua một hàng đợi promise.
 *
 * Quy tắc: mỗi cặp (workExchange, retryExchange) chỉ dành cho một queue (xem `ConsumerTopology`).
 */
export class BrokerClient {
  readonly publisher = new ConfirmPublisher();
  readonly #log: BrokerLogger;
  readonly #stopTimeoutMs: number;
  readonly #registrations: Registration[] = [];
  /** Mọi consumer đã bật mà chưa chắc đã drain (kể cả của các lần kết nối trước). */
  readonly #started = new Set<RunningConsumer>();
  readonly #timers = new Map<string, NodeJS.Timeout>();
  #model: { close(): Promise<void> } | undefined;
  #channelModel: ChannelModel | undefined;
  #publishChannel: ConfirmChannel | undefined;
  #consumeChannel: Channel | undefined;
  #closing = false;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(log: BrokerLogger, stopTimeoutMs: number) {
    this.#log = log;
    this.#stopTimeoutMs = stopTimeoutMs;
  }

  static async connect(options: {
    config: BrokerConfig;
    log: BrokerLogger;
    initialMaxRetries?: number;
    /** Thời gian tối đa `stopConsuming()` chờ handler đang chạy. Mặc định 30 s. */
    stopTimeoutMs?: number;
  }): Promise<BrokerClient> {
    const client = new BrokerClient(options.log, options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS);
    const { config } = options;
    const model = await connect(
      {
        protocol: 'amqp',
        hostname: config.host,
        port: config.port,
        username: config.user,
        password: config.password,
        vhost: config.vhost,
      },
      {
        recovery: {
          initialDelay: 200,
          maxDelay: 5_000,
          initialMaxRetries: options.initialMaxRetries ?? 5,
          setup: (channelModel: ChannelModel) => client.#setup(channelModel),
        },
      },
    );
    model.on('disconnect', (error) => {
      client.#onDisconnect();
      client.#log.warn({ err: error.message }, 'broker connection lost; recovering');
    });
    model.on('connect-failed', (error) =>
      client.#log.warn({ err: error.message }, 'broker connection attempt failed'),
    );
    model.on('reconnect-scheduled', (info) =>
      client.#log.warn(
        { attempt: info.attempt, delayMs: info.delay, err: info.error.message },
        'broker reconnect scheduled',
      ),
    );
    model.on('reconnect-failed', (error) =>
      client.#log.error({ err: error.message }, 'broker reconnect gave up'),
    );
    model.on('error', (error) =>
      client.#log.error({ err: error.message }, 'broker connection error'),
    );
    client.#model = model;
    return client;
  }

  /** Chỉ để test: hai channel hiện hành, cho phép gây lỗi channel từ phía test. */
  get channelsForTesting(): { publish: ConfirmChannel | undefined; consume: Channel | undefined } {
    return { publish: this.#publishChannel, consume: this.#consumeChannel };
  }

  consume(spec: ConsumerSpec): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closing) throw new Error('broker client is closing; cannot register a consumer');
      const { workExchange, retryExchange, queue } = spec.topology;
      for (const other of this.#registrations) {
        const used = [other.spec.topology.workExchange, other.spec.topology.retryExchange];
        if (
          other.spec.topology.queue !== queue &&
          (used.includes(workExchange) || used.includes(retryExchange))
        ) {
          throw new Error(
            `exchanges ${workExchange}/${retryExchange} are already used by queue ${other.spec.topology.queue}; ` +
              'use one consumer queue per (workExchange, retryExchange) pair',
          );
        }
      }
      const registration: Registration = { spec, running: undefined };
      this.#registrations.push(registration);
      const model = this.#channelModel;
      const channel = this.#consumeChannel;
      if (model && channel) {
        try {
          await this.#start(registration, model, channel);
        } catch (error) {
          this.#registrations.splice(this.#registrations.indexOf(registration), 1);
          throw error;
        }
      }
    });
  }

  async stopConsuming(): Promise<void> {
    this.#closing = true;
    this.#clearTimers();
    const consumers = [...this.#started];
    this.#started.clear();
    for (const registration of this.#registrations) registration.running = undefined;
    let timer: NodeJS.Timeout | undefined;
    const timedOut = await Promise.race([
      Promise.allSettled(consumers.map((consumer) => consumer.stop())).then(() => false),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(true), this.#stopTimeoutMs);
      }),
    ]);
    clearTimeout(timer);
    if (timedOut) {
      this.#log.warn(
        { timeoutMs: this.#stopTimeoutMs },
        'handlers still running after stop timeout; continuing shutdown',
      );
    }
  }

  async close(): Promise<void> {
    await this.stopConsuming();
    this.publisher.detachAll();
    await this.#model?.close().catch(() => undefined);
  }

  #serialize<T>(task: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  #clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer);
    this.#timers.clear();
  }

  /** Lên lịch chạy `task` (tuần tự hóa) với backoff; thất bại thì tự lên lịch lại. Mỗi `label` chỉ một lịch. */
  #retryLater(label: string, attempt: number, task: () => Promise<void>): void {
    if (this.#closing || this.#timers.has(label)) return;
    const delay = Math.min(RESTART_BASE_MS * 2 ** attempt, RESTART_MAX_MS);
    const timer = setTimeout(() => {
      this.#timers.delete(label);
      if (this.#closing) return;
      this.#serialize(task).catch((error: unknown) => {
        this.#log.warn(
          { err: errorText(error), what: label, attempt: attempt + 1 },
          'restart failed; will retry',
        );
        this.#retryLater(label, attempt + 1, task);
      });
    }, delay);
    this.#timers.set(label, timer);
  }

  #onDisconnect(): void {
    this.publisher.detachAll();
    this.#clearTimers();
    this.#channelModel = undefined;
    this.#publishChannel = undefined;
    this.#consumeChannel = undefined;
    for (const registration of this.#registrations) registration.running = undefined;
  }

  #setup(model: ChannelModel): Promise<void> {
    return this.#serialize(async () => {
      if (this.#closing) return;
      this.#clearTimers();
      this.#channelModel = model;
      for (const registration of this.#registrations) registration.running = undefined;
      await this.#openPublishChannel(model);
      await this.#openConsumeChannel(model);
    });
  }

  async #openPublishChannel(model: ChannelModel): Promise<void> {
    const channel = await model.createConfirmChannel();
    channel.on('error', (error) =>
      this.#log.error({ err: error.message }, 'publish channel error'),
    );
    channel.on('close', () => {
      this.publisher.detach(channel);
      if (this.#closing || this.#publishChannel !== channel || this.#channelModel !== model) return;
      this.#publishChannel = undefined;
      this.#log.warn({}, 'publish channel closed; reopening');
      this.#retryLater('publish-channel', 0, async () => {
        if (this.#closing || this.#channelModel !== model || this.#publishChannel) return;
        await this.#openPublishChannel(model);
      });
    });
    this.#publishChannel = channel;
    this.publisher.attach(channel);
  }

  async #openConsumeChannel(model: ChannelModel): Promise<void> {
    const channel = await model.createChannel();
    channel.on('error', (error) =>
      this.#log.error({ err: error.message }, 'consume channel error'),
    );
    channel.on('close', () => {
      if (this.#closing || this.#consumeChannel !== channel || this.#channelModel !== model) return;
      this.#consumeChannel = undefined;
      for (const registration of this.#registrations) registration.running = undefined;
      this.#log.warn({}, 'consume channel closed; reopening');
      this.#retryLater('consume-channel', 0, async () => {
        if (this.#closing || this.#channelModel !== model || this.#consumeChannel) return;
        await this.#openConsumeChannel(model);
      });
    });
    this.#consumeChannel = channel;
    for (const registration of this.#registrations) {
      if (this.#closing) return;
      await this.#startIsolated(registration, model, channel);
    }
  }

  /** Bật một consumer; lỗi chỉ được log và lên lịch thử lại riêng consumer đó. */
  async #startIsolated(
    registration: Registration,
    model: ChannelModel,
    channel: Channel,
  ): Promise<void> {
    if (this.#closing || registration.running) return;
    try {
      await this.#start(registration, model, channel);
    } catch (error) {
      const queue = registration.spec.topology.queue;
      this.#log.error({ err: errorText(error), queue }, 'could not start consumer; will retry');
      this.#retryLater(`consumer:${queue}`, 0, () => this.#restartOne(registration, model));
    }
  }

  async #restartOne(registration: Registration, model: ChannelModel): Promise<void> {
    const channel = this.#consumeChannel;
    if (this.#closing || this.#channelModel !== model || !channel || registration.running) return;
    await this.#start(registration, model, channel);
  }

  async #start(registration: Registration, model: ChannelModel, channel: Channel): Promise<void> {
    // Kênh dùng một lần: nếu exchange nguồn thiếu, broker đóng nó (404) mà không ảnh hưởng consumer khác.
    const declaring = await model.createChannel();
    declaring.on('error', () => undefined);
    try {
      await declareConsumerTopology(declaring, registration.spec.topology);
    } finally {
      await declaring.close().catch(() => undefined);
    }
    const queue = registration.spec.topology.queue;
    const running: RunningConsumer = await startConsumer({
      channel,
      publisher: this.publisher,
      spec: registration.spec,
      log: this.#log,
      onCancel: () => {
        if (this.#closing || registration.running !== running) return;
        registration.running = undefined;
        this.#log.warn({ queue }, 'consumer cancelled by broker; restarting');
        this.#retryLater(`consumer:${queue}`, 0, () => this.#restartOne(registration, model));
      },
    });
    registration.running = running;
    const current = new Set(this.#registrations.map((r) => r.running));
    for (const consumer of this.#started) {
      if (!current.has(consumer) && consumer.inflight() === 0) this.#started.delete(consumer);
    }
    this.#started.add(running);
    this.#log.info({ queue }, 'consumer started');
  }
}
