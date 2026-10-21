// Bài 1 (Cơ bản): tiền bằng SỐ NGUYÊN (đơn vị nhỏ nhất, "cent"), không dùng số thập phân.
// toCents('12.34') -> 1234     toCents('5') -> 500     toCents('0.1') -> 10     toCents('12.5') -> 1250
// fromCents(1234)  -> '12.34'  fromCents(5) -> '0.05'  fromCents(500) -> '5.00'
// Chuỗi không đúng dạng tiền ('abc', '1.234', '', '-1') -> throw new Error('invalid money: <chuỗi>')
// Gợi ý: kiểm tra bằng biểu thức chính quy /^\d+(\.\d{1,2})?$/ ; tách phần nguyên và phần lẻ bằng split('.').
// KHÔNG dùng Number(text) * 100 (vì 1.005 * 100 sai số). Hãy tự ghép chuỗi.
export function toCents(text: string): number {
  // TODO
  return NaN;
}

export function fromCents(cents: number): string {
  // TODO
  return '';
}
