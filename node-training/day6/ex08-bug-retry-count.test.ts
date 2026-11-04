// Import các hàm của vitest: `test` để khai báo một ca kiểm thử, `expect` để so sánh kết quả.
import { expect, test } from 'vitest';
// Import hàm cần kiểm tra (đuôi .js là quy ước của ESM dù file thật là .ts).
import { retryTimes } from './ex08-bug-retry-count.js';

// Ca 1: task luôn lỗi, retries = 2 -> phải gọi 1 lần đầu + 2 lần thử lại = 3 lần.
test('retries = 2: gọi tối đa 3 lần', async () => {
  // Biến đếm số lần task thực sự bị gọi.
  let calls = 0;

  // `.rejects.toThrow` = mong đợi retryTimes bị từ chối (ném lỗi) với thông báo 'hỏng'.
  await expect(
    retryTimes(async () => {
      calls += 1; // mỗi lần task chạy thì tăng đếm
      throw new Error('hỏng'); // task luôn thất bại
    }, 2),
  ).rejects.toThrow('hỏng');

  // Kiểm tra tổng số lần gọi đúng bằng 3 (đây là chỗ hay fail khi code đếm sai).
  expect(calls).toBe(3);
});

// Ca 2: task lỗi 2 lần đầu, đến lần thứ 3 mới thành công -> retryTimes phải trả 'ok'.
test('thành công ở lần thử lại cuối', async () => {
  let calls = 0;

  const result = await retryTimes(async () => {
    calls += 1;
    // Lần 1 và 2 (calls < 3) thì lỗi; lần 3 trở đi chạy xuống dưới và thành công.
    if (calls < 3) throw new Error('hỏng');
    return 'ok';
  }, 2); // cho phép 2 lần thử lại => tối đa 3 lần gọi, vừa đủ để thành công ở lần 3

  // Kết quả trả về phải là giá trị của lần thành công.
  expect(result).toBe('ok');
});

// Ca 3: retries = 0 nghĩa là KHÔNG thử lại, nhưng vẫn phải gọi đúng 1 lần.
test('retries = 0: chỉ gọi một lần', async () => {
  let calls = 0;

  await expect(
    retryTimes(async () => {
      calls += 1;
      throw new Error('hỏng'); // task thất bại
    }, 0),
  ).rejects.toThrow('hỏng'); // lỗi được ném ra cho người gọi

  // Chỉ 1 lần gọi duy nhất, không có lần thử lại.
  expect(calls).toBe(1);
});
