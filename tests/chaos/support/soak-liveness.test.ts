import { describe, expect, it } from 'vitest';
import { assertLoadLiveness } from './soak.js';

describe('assertLoadLiveness', () => {
  it('chấp nhận loại hiếm chưa được thử lần nào (vòng ngắn)', () => {
    expect(() =>
      assertLoadLiveness({
        succeeded: { topup: 8, order: 11, adjust: 4, read: 9 },
        attempted: { topup: 8, order: 11, adjust: 4, read: 9, unfreeze: 1 },
      }),
    ).not.toThrow();
  });

  it('chấp nhận loại ít được thử (< 5 lần) dù chưa thành công', () => {
    expect(() =>
      assertLoadLiveness({
        succeeded: { topup: 3 },
        attempted: { topup: 3, freeze: 4 },
      }),
    ).not.toThrow();
  });

  it('ném khi một loại chính đã thử đủ nhiều mà chưa từng thành công', () => {
    expect(() =>
      assertLoadLiveness({
        succeeded: { topup: 3 },
        attempted: { topup: 3, freeze: 5 },
      }),
    ).toThrow(/freeze chưa từng thành công dù đã thử 5 lần/);
  });

  it('ném khi không thao tác nào thành công', () => {
    expect(() => assertLoadLiveness({ succeeded: {}, attempted: { topup: 2 } })).toThrow(
      /không thao tác tải nào thành công/,
    );
  });
});
