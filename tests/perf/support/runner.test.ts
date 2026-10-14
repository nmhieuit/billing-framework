import { describe, expect, it } from 'vitest';
import {
  estimateMaxOps,
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

describe('reportFileName', () => {
  it('ghép kịch bản và nhãn máy, đổi ký tự lạ thành gạch dưới', () => {
    expect(reportFileName('pay-order', 'my laptop/1')).toBe('pay-order-my_laptop_1');
  });
});
