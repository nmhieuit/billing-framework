// Bài 4 (Trung bình) — viết test cho code THẬT của dự án.
// Sao chép file này thành services/wallet/src/domain/topup.day7.test.ts (bỏ đuôi .tpl) rồi hoàn thành các test.
// Kịch bản: cấu hình mặc định TOPUP_SUBMIT_BACKOFF = 1,5,30,120,600 giây (services/wallet/src/config.ts:41).
// Test hiện có trong topup.test.ts chỉ thử với [1, 5]; hãy kiểm tra chuỗi mặc định đầy đủ.
import { Money } from '@billing/money';
import { describe, expect, it } from 'vitest';
import { CustomerId } from './customer-id.js';
import { Topup } from './topup.js';

const DEFAULT_BACKOFF = [1, 5, 30, 120, 600];
const t0 = new Date('2026-10-10T10:00:00.000Z');
const seconds = (n: number) => new Date(t0.getTime() + n * 1000);

const requested = () =>
  Topup.request({
    id: 'tp_1',
    customerId: CustomerId.parse('c1'),
    accountId: 'wallet:c1',
    amount: Money.of(1500, 'VND'),
    now: t0,
  });

describe('Topup.recordUnavailable với backoff mặc định', () => {
  it('hẹn lại đúng 1, 5, 30, 120, 600 giây sau mỗi lần thất bại', () => {
    // TODO: gọi recordUnavailable 5 lần liên tiếp (mỗi lần dùng "now" = đúng nextAttemptAt của lần trước)
    // và kiểm tra status vẫn REQUESTED, attempts tăng 1..5, nextAttemptAt cách "now" lần lượt 1, 5, 30, 120, 600 giây.
    expect(requested).toBeDefined();
    expect(seconds).toBeDefined();
    expect(DEFAULT_BACKOFF).toHaveLength(5);
    throw new Error('chưa viết test');
  });

  it('lần thất bại thứ 6 là FAILED với PAYMENT_UNAVAILABLE', () => {
    // TODO
    throw new Error('chưa viết test');
  });

  it('một lần thành công giữa chừng chặn mọi lần thất bại sau đó', () => {
    // TODO: thất bại 2 lần, rồi recordSubmitted('ch_1') -> PENDING; gọi tiếp recordUnavailable phải ném StateTransitionError
    throw new Error('chưa viết test');
  });
});
