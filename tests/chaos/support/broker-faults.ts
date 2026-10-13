import type {
  EventPublisher,
  OutboxMessage,
  PublishOutcome,
} from '../../../services/wallet/src/application/ports.js';
import type { TestBroker } from '@billing/testing';
import type { FaultPlan } from './fault-plan.js';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

// Bọc publisher: rule ở 'broker.publish.before' ném => message mất, không tới broker;
// rule ở 'broker.publish.after' ném => message ĐÃ tới broker nhưng publisher báo failed
// (mô phỏng mất ack). Chỉ lỗi từ plan.hit bị chuyển thành `failed`; lỗi của publisher thật vẫn ném tiếp.
export function faultyPublisher(plan: FaultPlan): (publisher: EventPublisher) => EventPublisher {
  return (publisher) => ({
    async publish(message: OutboxMessage): Promise<PublishOutcome> {
      const base = { id: message.id, eventType: message.eventType };
      try {
        await plan.hit('broker.publish.before', { ...base });
      } catch (error) {
        return { kind: 'failed', error: messageOf(error) };
      }
      const outcome = await publisher.publish(message);
      try {
        await plan.hit('broker.publish.after', { ...base, outcome });
      } catch (error) {
        return { kind: 'failed', error: messageOf(error) };
      }
      return outcome;
    },
  });
}

// Đóng kết nối AMQP của vhost (của riêng `user` nếu có); dùng làm action của rule. Trả số kết nối đã đóng.
export function dropBrokerConnections(broker: TestBroker, user?: string): Promise<number> {
  return broker.closeConnections(user === undefined ? {} : { user });
}
