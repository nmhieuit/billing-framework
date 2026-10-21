// Bài 8 (Sửa lỗi): dữ liệu từ ô nhập liệu luôn là chuỗi (string).
// addAmounts('10', '5') phải trả về 15 (số), nhưng đang trả về '105'.
// Nếu một giá trị không phải số (ví dụ 'abc') -> throw new Error('invalid amount: abc')
export function addAmounts(a, b) {
  return a + b;
}
