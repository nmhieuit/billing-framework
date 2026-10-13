import type {
  EventPublisher,
  OutboxMessage,
} from '../../../services/wallet/src/application/ports.js';
import { describe, expect, it } from 'vitest';
import { faultyPublisher } from './broker-faults.js';
import { FaultPlan } from './fault-plan.js';
import { OpLog } from './op-log.js';

const message: OutboxMessage = {
  id: 'm-1',
  eventType: 'wallet.credited',
  routingKey: 'wallet.credited',
  payload: '{}',
  correlationId: 'c-1',
  createdAt: new Date(0),
  attempts: 0,
  nextAttemptAt: new Date(0),
};

// Publisher giả ghi nhận lời gọi thật sự tới "broker".
function fakePublisher(): { publisher: EventPublisher; delivered: string[] } {
  const delivered: string[] = [];
  return {
    delivered,
    publisher: {
      async publish(m) {
        delivered.push(m.id);
        return { kind: 'delivered' };
      },
    },
  };
}

const newPlan = (): FaultPlan => new FaultPlan({ log: new OpLog() });

describe('faultyPublisher', () => {
  it('không có rule thì chuyển tiếp nguyên vẹn', async () => {
    const { publisher, delivered } = fakePublisher();
    const plan = newPlan();
    const wrapped = faultyPublisher(plan)(publisher);
    expect(await wrapped.publish(message)).toEqual({ kind: 'delivered' });
    expect(delivered).toEqual(['m-1']);
    expect(plan.hits('broker.publish.before')).toBe(1);
    expect(plan.hits('broker.publish.after')).toBe(1);
  });

  it('rule before ném: publisher thật KHÔNG được gọi, trả failed', async () => {
    const { publisher, delivered } = fakePublisher();
    const plan = newPlan().add({
      point: 'broker.publish.before',
      action: () => {
        throw new Error('mất trước khi gửi');
      },
    });
    const outcome = await faultyPublisher(plan)(publisher).publish(message);
    expect(outcome).toEqual({ kind: 'failed', error: 'mất trước khi gửi' });
    expect(delivered).toEqual([]);
    expect(plan.hits('broker.publish.after')).toBe(0);
  });

  it('rule after ném: message ĐÃ tới broker nhưng kết quả trả về là failed', async () => {
    const { publisher, delivered } = fakePublisher();
    const plan = newPlan().add({
      point: 'broker.publish.after',
      action: () => {
        throw new Error('mất ack');
      },
    });
    const outcome = await faultyPublisher(plan)(publisher).publish(message);
    expect(outcome).toEqual({ kind: 'failed', error: 'mất ack' });
    expect(delivered).toEqual(['m-1']);
  });

  it('info truyền id, eventType và outcome của publisher thật', async () => {
    const { publisher } = fakePublisher();
    const seen: Array<Record<string, unknown>> = [];
    const plan = newPlan()
      .add({ point: 'broker.publish.before', action: (i) => void seen.push({ ...i }) })
      .add({ point: 'broker.publish.after', action: (i) => void seen.push({ ...i }) });
    await faultyPublisher(plan)(publisher).publish(message);
    expect(seen).toEqual([
      { id: 'm-1', eventType: 'wallet.credited' },
      { id: 'm-1', eventType: 'wallet.credited', outcome: { kind: 'delivered' } },
    ]);
  });

  it('rule chỉ bắn đúng lần thứ n (nth)', async () => {
    const { publisher, delivered } = fakePublisher();
    const plan = newPlan().add({
      point: 'broker.publish.before',
      nth: 2,
      action: () => {
        throw new Error('lần 2');
      },
    });
    const wrapped = faultyPublisher(plan)(publisher);
    const kinds: string[] = [];
    for (const id of ['a', 'b', 'c']) kinds.push((await wrapped.publish({ ...message, id })).kind);
    expect(kinds).toEqual(['delivered', 'failed', 'delivered']);
    expect(delivered).toEqual(['a', 'c']);
  });

  it('lỗi của publisher thật không bị nuốt', async () => {
    const plan = newPlan();
    const boom: EventPublisher = {
      async publish() {
        throw new Error('publisher hỏng');
      },
    };
    await expect(faultyPublisher(plan)(boom).publish(message)).rejects.toThrow('publisher hỏng');
  });
});
