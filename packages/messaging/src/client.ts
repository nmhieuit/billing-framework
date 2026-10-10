import { connect, type Channel, type ChannelModel } from 'amqplib';
import { startConsumer, type ConsumerSpec, type RunningConsumer } from './consumer.js';
import { ConfirmPublisher } from './publisher.js';
import { declareConsumerTopology } from './topology.js';
import type { BrokerConfig, BrokerLogger } from './types.js';

interface Registration {
  spec: ConsumerSpec;
  running: RunningConsumer | undefined;
}

/**
 * Một kết nối tự phục hồi: sau mỗi lần (kết nối lại) `setup` tạo lại confirm channel cho publisher, channel cho
 * consumer và bật lại mọi consumer đã đăng ký. Mất kết nối giữa chừng: message chưa ack được broker giao lại
 * (consumer nhận `redelivered = true`), còn publish trong lúc mất kết nối trả `failed` để bên gọi thử lại.
 */
export class BrokerClient {
  readonly publisher = new ConfirmPublisher();
  readonly #log: BrokerLogger;
  readonly #registrations: Registration[] = [];
  #model: { close(): Promise<void> } | undefined;
  #channelModel: ChannelModel | undefined;
  #consumeChannel: Channel | undefined;
  #closing = false;

  private constructor(log: BrokerLogger) {
    this.#log = log;
  }

  static async connect(options: {
    config: BrokerConfig;
    log: BrokerLogger;
    initialMaxRetries?: number;
  }): Promise<BrokerClient> {
    const client = new BrokerClient(options.log);
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
      client.publisher.detachAll();
      client.#log.warn({ err: error.message }, 'broker connection lost; recovering');
    });
    model.on('error', (error) =>
      client.#log.error({ err: error.message }, 'broker connection error'),
    );
    client.#model = model;
    return client;
  }

  async consume(spec: ConsumerSpec): Promise<void> {
    const registration: Registration = { spec, running: undefined };
    this.#registrations.push(registration);
    if (this.#channelModel && this.#consumeChannel) {
      try {
        await this.#start(registration, this.#channelModel, this.#consumeChannel);
      } catch (error) {
        this.#registrations.splice(this.#registrations.indexOf(registration), 1);
        throw error;
      }
    }
  }

  async stopConsuming(): Promise<void> {
    this.#closing = true;
    for (const registration of this.#registrations) {
      await registration.running?.stop();
      registration.running = undefined;
    }
  }

  async close(): Promise<void> {
    await this.stopConsuming();
    this.publisher.detachAll();
    await this.#model?.close().catch(() => undefined);
  }

  async #setup(model: ChannelModel): Promise<void> {
    const publishChannel = await model.createConfirmChannel();
    publishChannel.on('error', (error) =>
      this.#log.error({ err: error.message }, 'publish channel error'),
    );
    publishChannel.on('close', () => this.publisher.detach(publishChannel));
    this.publisher.attach(publishChannel);

    const consumeChannel = await model.createChannel();
    consumeChannel.on('error', (error) =>
      this.#log.error({ err: error.message }, 'consume channel error'),
    );
    this.#channelModel = model;
    this.#consumeChannel = consumeChannel;

    if (this.#closing) return;
    for (const registration of this.#registrations) {
      await this.#start(registration, model, consumeChannel);
    }
  }

  async #start(
    registration: Registration,
    model: ChannelModel,
    consumeChannel: Channel,
  ): Promise<void> {
    // Kênh dùng một lần: nếu exchange nguồn thiếu, broker đóng nó (404) mà không ảnh hưởng consumer khác.
    const declaring = await model.createChannel();
    declaring.on('error', () => undefined);
    try {
      await declareConsumerTopology(declaring, registration.spec.topology);
    } finally {
      await declaring.close().catch(() => undefined);
    }
    registration.running = await startConsumer({
      channel: consumeChannel,
      publisher: this.publisher,
      spec: registration.spec,
      log: this.#log,
    });
    this.#log.info({ queue: registration.spec.topology.queue }, 'consumer started');
  }
}
