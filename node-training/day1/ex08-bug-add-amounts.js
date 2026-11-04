// Bài 8 (Sửa lỗi): dữ liệu từ ô nhập liệu luôn là chuỗi (string).
// addAmounts('10', '5') phải trả về 15 (số), nếu cộng thẳng sẽ ra '105' (nối chuỗi).
// Nếu một giá trị không phải số (ví dụ 'abc') -> throw new Error('invalid amount: abc')

export function addAmounts(a, b) {
  // isNaN(x): true nếu x không thể đổi thành số ('abc' -> true, '10' -> false)
  if (isNaN(a)) {
    throw new Error(`invalid amount: ${a}`);
  }
  if (isNaN(b)) {
    throw new Error(`invalid amount: ${b}`);
  }

  // Đổi sang số trước khi cộng, nếu không toán tử + sẽ nối chuỗi
  const numberA = Number(a);
  const numberB = Number(b);

  return numberA + numberB;
}
