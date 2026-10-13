import { createTestBroker, type TestBroker } from '@billing/testing';
import { connect, type ChannelModel } from 'amqplib';
import { afterEach, describe, expect, it } from 'vitest';
import { dropBrokerConnections } from './broker-faults.js';

const brokers: TestBroker[] = [];
afterEach(async () => {
  while (brokers.length > 0) await brokers.pop()?.drop();
});

async function open(access: TestBroker['wallet']): Promise<ChannelModel> {
  const connection = await connect({
    hostname: access.host,
    port: access.port,
    vhost: access.vhost,
    username: access.user,
    password: access.password,
  });
  connection.on('error', () => undefined);
  return connection;
}

describe('dropBrokerConnections', () => {
  it('đóng kết nối đang mở của user và trả số > 0', async () => {
    const broker = await createTestBroker('chaos_broker');
    brokers.push(broker);
    const connection = await open(broker.wallet);
    const closed = new Promise<void>((resolve) => connection.once('close', () => resolve()));

    const dropped = await dropBrokerConnections(broker, broker.wallet.user);
    expect(dropped).toBeGreaterThan(0);
    await closed; // client thật sự thấy kết nối bị đóng
  });

  it('lọc theo user: kết nối của user khác còn nguyên', async () => {
    const broker = await createTestBroker('chaos_broker');
    brokers.push(broker);
    const wallet = await open(broker.wallet);
    const shop = await open(broker.ecommerce);
    let shopClosed = false;
    shop.once('close', () => (shopClosed = true));
    const walletClosed = new Promise<void>((resolve) => wallet.once('close', () => resolve()));

    expect(await dropBrokerConnections(broker, broker.wallet.user)).toBe(1);
    await walletClosed;
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(shopClosed).toBe(false);
    await shop.close();
  });
});
