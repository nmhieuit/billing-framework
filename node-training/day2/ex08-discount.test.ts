import { expect, test } from 'vitest';
import { applyDiscount } from './ex08-discount.js';

// Việc của bạn: viết tối thiểu 5 test, mỗi test một tình huống, rồi xóa test "XÓA SAU KHI XONG" bên dưới.
// Gợi ý tình huống: giảm 10%; giảm 0%; giảm 100%; làm tròn (999 giảm 50%); percent = -1; percent = 101.
test.todo('giảm 10%');
test.todo('giảm 0% giữ nguyên giá');
test.todo('giảm 100% còn 0');
test.todo('làm tròn');
test.todo('percent âm bị từ chối');

test('XÓA SAU KHI XONG: bạn đã viết đủ 5 test', () => {
  void applyDiscount;
  throw new Error('chưa viết test');
});
