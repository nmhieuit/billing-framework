import { describe, expect, it } from 'vitest';
import {
  estimateMaxOps,
  observedMaxOps,
  PER_WORKER_OPS_PER_SEC,
  reportFileName,
  SAFETY_FACTOR,
  TOTAL_OPS_PER_SEC,
} from './runner.js';

describe('estimateMaxOps', () => {
  it('bị chặn bởi trần mỗi luồng ở mức thấp và trần tổng ở mức cao', () => {
    expect(estimateMaxOps(1, 10)).toBe(Math.ceil(PER_WORKER_OPS_PER_SEC * 10 * SAFETY_FACTOR) + 2);
    expect(estimateMaxOps(64, 10)).toBe(Math.ceil(TOTAL_OPS_PER_SEC * 10 * SAFETY_FACTOR) + 128);
  });

  it('không giảm khi tăng mức đồng thời hoặc thời lượng', () => {
    expect(estimateMaxOps(4, 10)).toBeGreaterThanOrEqual(estimateMaxOps(2, 10));
    expect(estimateMaxOps(4, 20)).toBeGreaterThan(estimateMaxOps(4, 10));
  });
});

describe('observedMaxOps', () => {
  const config = { durationSeconds: 10, warmupSeconds: 2 };

  it('theo thông lượng lần lặp trước nhân 1.5 trên cả khởi động + đo, cộng các lệnh đang bay', () => {
    // 100 ok + 20 lỗi trong 10 s = 12 ops/s -> 12 x 12 s x 1.5 = 216, cộng 2 x 4 luồng.
    expect(observedMaxOps({ ok: 100, errors: 20 }, config, 4, 1_000_000)).toBe(216 + 8);
  });

  it('không bao giờ vượt cận tĩnh', () => {
    expect(observedMaxOps({ ok: 100_000, errors: 0 }, config, 4, 500)).toBe(500);
  });
});

describe('reportFileName', () => {
  it('ghép kịch bản và nhãn máy, đổi ký tự lạ thành gạch dưới', () => {
    expect(reportFileName('pay-order', 'my laptop/1')).toBe('pay-order-my_laptop_1');
  });
});
