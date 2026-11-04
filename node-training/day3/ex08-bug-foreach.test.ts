import { expect, test } from 'vitest';
import { totalAmount } from './ex08-bug-foreach.js';

// Dữ liệu giả: id nào ứng với số tiền nào
const amounts: Record<string, number> = { a: 10, b: 20, c: 30 };

// Hàm tải giả: mất 10ms rồi trả về số tiền của id (không có thì 0)
function loadAmount(id: string) {
  return new Promise<number>(function (resolve) {
    setTimeout(function () {
      resolve(amounts[id] ?? 0);
    }, 10);
  });
}

test('cộng đủ các số tiền', async () => {
  expect(await totalAmount(['a', 'b', 'c'], loadAmount)).toBe(60);
});

test('danh sách rỗng', async () => {
  expect(await totalAmount([], loadAmount)).toBe(0);
});
