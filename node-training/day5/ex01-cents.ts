// Bài 1 (Cơ bản): tiền bằng SỐ NGUYÊN (đơn vị nhỏ nhất, "cent"), không dùng số thập phân.
// toCents('12.34') -> 1234     toCents('5') -> 500     toCents('0.1') -> 10     toCents('12.5') -> 1250
// fromCents(1234)  -> '12.34'  fromCents(5) -> '0.05'  fromCents(500) -> '5.00'
// Chuỗi không đúng dạng tiền ('abc', '1.234', '', '-1') -> throw new Error('invalid money: <chuỗi>')
// Lý do không dùng Number(text) * 100: số thập phân bị sai số (ví dụ 0.1 + 0.2 = 0.30000000000000004).

// Đổi chuỗi tiền sang số cent
export function toCents(text: string): number {
  // Biểu thức chính quy (regex) mô tả dạng hợp lệ:
  //   ^        bắt đầu chuỗi
  //   \d+      một hay nhiều chữ số (phần nguyên)
  //   (\.\d{1,2})?   tùy chọn: dấu chấm rồi 1 hoặc 2 chữ số (phần lẻ)
  //   $        kết thúc chuỗi
  const moneyPattern = /^\d+(\.\d{1,2})?$/;
  if (!moneyPattern.test(text)) {
    throw new Error(`invalid money: ${text}`);
  }

  // split('.') cắt tại dấu chấm: '12.34' -> ['12', '34'], '5' -> ['5']
  const parts = text.split('.');
  const integerPart = parts[0]; // phần nguyên
  const decimalPart = parts[1]; // phần lẻ (có thể là undefined)

  // Phần nguyên x 100 (1 đơn vị = 100 cent)
  let cents = parseInt(integerPart, 10) * 100;

  if (decimalPart !== undefined) {
    // padEnd(2, '0') bù số 0 cho đủ 2 chữ số: '1' -> '10' (0.1 = 10 cent)
    cents = cents + parseInt(decimalPart.padEnd(2, '0'), 10);
  }
  return cents;
}

// Đổi số cent về chuỗi tiền
export function fromCents(cents: number): string {
  // Math.floor làm tròn xuống: 1234 / 100 = 12.34 -> 12
  const integerPart = Math.floor(cents / 100);
  // % lấy phần dư: 1234 % 100 = 34. padStart(2, '0') bù số 0 phía trước: '5' -> '05'
  const decimalPart = String(cents % 100).padStart(2, '0');
  return `${integerPart}.${decimalPart}`;
}
