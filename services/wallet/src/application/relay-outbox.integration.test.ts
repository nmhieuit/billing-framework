import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TenantId } from '../domain/tenant-id.js';
import { createHarness, type Harness } from '../test-support.js';
import type {
  EventPublisher,
  Logger,
  NewOutboxMessage,
  OutboxMessage,
  PublishOutcome,
} from './ports.js';
import { RelayOutbox } from './relay-outbox.js';

class ScriptedPublisher implements EventPublisher {
  readonly published: OutboxMessage[] = [];
  readonly script: Array<PublishOutcome | 'throw'> = [];
  onPublish: ((message: OutboxMessage) => Promise<void>) | undefined;

  async publish(message: OutboxMessage): Promise<PublishOutcome> {
    this.published.push(message);
    await this.onPublish?.(message);
    const next = this.script.shift() ?? { kind: 'delivered' };
    if (next === 'throw') throw new Error('publisher blew up');
    return next;
  }
}

let h: Harness;
let publisher: ScriptedPublisher;
let relay: RelayOutbox;
let logs: Array<{ level: string; details: object; message: string | undefined }>;
let counter = 0;
const T0 = '2026-10-10T10:00:00.000Z';

beforeAll(async () => {
  h = await createHarness();
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  for (const schema of ['t_acme', 't_beta']) {
    await h.db.withSchema(schema).updateTable('outbox').set({ status: 'SENT' }).execute();
  }
  h.clock.set(T0);
  logs = [];
  const log: Logger = {
    info: (details, message) => logs.push({ level: 'info', details, message }),
    warn: (details, message) => logs.push({ level: 'warn', details, message }),
    error: (details, message) => logs.push({ level: 'error', details, message }),
  };
  publisher = new ScriptedPublisher();
  relay = new RelayOutbox({ uow: h.uow, publisher, clock: h.clock, log, backoffSeconds: [1, 5] });
});
afterEach(() => undefined);

const enqueue = async (tenant: TenantId = h.acme, createdAt = h.clock.now()): Promise<string> => {
  const id = `00000000-0000-4000-9000-${String(++counter).padStart(12, '0')}`;
  const message: NewOutboxMessage = {
    id,
    eventType: 'OrderPaidV1',
    routingKey: 'order-paid.v1',
    payload: JSON.stringify({ id }),
    correlationId: 'corr-1',
    createdAt,
  };
  await h.uow.run(tenant, ({ outbox }) => outbox.add(message));
  return id;
};
const rowOf = (id: string, tenant: TenantId = h.acme) =>
  h.db
    .withSchema(`t_${tenant.value}`)
    .selectFrom('outbox')
    .selectAll()
    .where('id', '=', id)
    .executeTakeFirstOrThrow();

describe('RelayOutbox', () => {
  it('publishes the oldest due message first, outside any transaction, and retires it', async () => {
    const second = await enqueue(h.acme, new Date('2026-10-10T09:59:00.000Z'));
    const first = await enqueue(h.acme, new Date('2026-10-10T09:58:00.000Z'));
    h.clock.set('2026-10-10T10:00:05.000Z');

    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(publisher.published.map((m) => m.id)).toEqual([first]);
    expect(await rowOf(first)).toMatchObject({
      status: 'SENT',
      sent_at: new Date('2026-10-10T10:00:05.000Z'),
    });
    expect((await rowOf(second)).status).toBe('PENDING');
  });

  it('does not hold the row lock while publishing', async () => {
    const id = await enqueue();
    let reachedDuringPublish = false;
    publisher.onPublish = async () => {
      const touched = h.db
        .withSchema('t_acme')
        .updateTable('outbox')
        .set({ correlation_id: 'touched-while-publishing' })
        .where('id', '=', id)
        .execute()
        .then(() => true);
      reachedDuringPublish = await Promise.race([
        touched,
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 3000)),
      ]);
    };
    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(reachedDuringPublish).toBe(true);
  });

  it('keeps an unroutable message PENDING, backs off by attempt count, caps at the last step, and finally delivers', async () => {
    const id = await enqueue();
    publisher.script.push({ kind: 'unroutable' }, { kind: 'unroutable' }, { kind: 'unroutable' });

    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    expect(await rowOf(id)).toMatchObject({
      status: 'PENDING',
      attempts: 1,
      next_attempt_at: new Date('2026-10-10T10:00:01.000Z'),
    });
    expect(await relay.executeNextDue(h.acme)).toBeNull();

    h.clock.advanceSeconds(1);
    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    expect(await rowOf(id)).toMatchObject({
      attempts: 2,
      next_attempt_at: new Date('2026-10-10T10:00:06.000Z'),
    });

    h.clock.advanceSeconds(5);
    expect(await relay.executeNextDue(h.acme)).toBe('UNROUTABLE');
    // Hết bậc backoff thì giữ nguyên bậc cuối (5 s), không bao giờ bỏ dòng.
    expect(await rowOf(id)).toMatchObject({
      attempts: 3,
      next_attempt_at: new Date('2026-10-10T10:00:11.000Z'),
    });

    h.clock.advanceSeconds(5);
    expect(await relay.executeNextDue(h.acme)).toBe('SENT');
    expect(await rowOf(id)).toMatchObject({ status: 'SENT' });
    expect(publisher.published.map((m) => m.id)).toEqual([id, id, id, id]);
  });

  it('treats a failed publish and a throwing publisher alike, and logs without leaking the payload', async () => {
    const id = await enqueue();
    publisher.script.push({ kind: 'failed', error: 'channel closed' }, 'throw');
    expect(await relay.executeNextDue(h.acme)).toBe('FAILED');
    h.clock.advanceSeconds(1);
    expect(await relay.executeNextDue(h.acme)).toBe('FAILED');
    expect(await rowOf(id)).toMatchObject({ status: 'PENDING', attempts: 2 });
    expect(logs.filter((l) => l.level === 'error')).toHaveLength(2);
    expect(JSON.stringify(logs)).not.toContain(`{"id":"${id}"}`);
  });

  it('warns (not errors) when nothing is bound to receive the event', async () => {
    await enqueue();
    publisher.script.push({ kind: 'unroutable' });
    await relay.executeNextDue(h.acme);
    expect(logs.map((l) => l.level)).toEqual(['warn']);
  });

  it('leaves a leased message alone until the lease expires (crash recovery), then sends it again', async () => {
    const id = await enqueue();
    let release: () => void = () => undefined;
    publisher.onPublish = () => new Promise<void>((resolve) => (release = resolve));
    const stuck = relay.executeNextDue(h.acme);
    await new Promise((resolve) => setTimeout(resolve, 300));

    const other = new ScriptedPublisher();
    const second = new RelayOutbox({
      uow: h.uow,
      publisher: other,
      clock: h.clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      backoffSeconds: [1],
    });
    expect(await second.executeNextDue(h.acme)).toBeNull();
    h.clock.advanceSeconds(61);
    expect(await second.executeNextDue(h.acme)).toBe('SENT');
    expect(other.published.map((m) => m.id)).toEqual([id]);

    release();
    await stuck;
  });

  it('honours the limit and stops claiming once shouldContinue turns false', async () => {
    for (let i = 0; i < 5; i++) await enqueue();
    expect(await relay.execute(h.acme, 2)).toEqual({ sent: 2, unroutable: 0, failed: 0 });
    let sends = 0;
    publisher.onPublish = async () => {
      sends += 1;
    };
    expect(await relay.execute(h.acme, 50, { shouldContinue: () => sends < 1 })).toEqual({
      sent: 1,
      unroutable: 0,
      failed: 0,
    });
    expect(await relay.execute(h.acme)).toEqual({ sent: 2, unroutable: 0, failed: 0 });
    expect(await relay.execute(h.acme)).toEqual({ sent: 0, unroutable: 0, failed: 0 });
  });

  it('counts outcomes in the report', async () => {
    for (let i = 0; i < 3; i++) await enqueue();
    publisher.script.push(
      { kind: 'delivered' },
      { kind: 'unroutable' },
      { kind: 'failed', error: 'x' },
    );
    expect(await relay.execute(h.acme)).toEqual({ sent: 1, unroutable: 1, failed: 1 });
  });

  it('only touches the given tenant', async () => {
    const inBeta = await enqueue(h.beta);
    await enqueue(h.acme);
    await relay.execute(h.acme);
    expect((await rowOf(inBeta, h.beta)).status).toBe('PENDING');
  });

  it('publishes every message exactly once when two relays run at once', async () => {
    const ids = await Promise.all(Array.from({ length: 6 }, () => enqueue()));
    const other = new ScriptedPublisher();
    const second = new RelayOutbox({
      uow: h.uow,
      publisher: other,
      clock: h.clock,
      log: { info: () => undefined, warn: () => undefined, error: () => undefined },
      backoffSeconds: [1],
    });
    await Promise.all([relay.execute(h.acme), second.execute(h.acme)]);
    const sent = [...publisher.published, ...other.published].map((m) => m.id).sort();
    expect(sent).toEqual([...ids].sort());
  });
});
