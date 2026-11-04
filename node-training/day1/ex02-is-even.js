// Bài 2 (Cơ bản): số chẵn.
// isEven(4) -> true, isEven(7) -> false.

export function isEven(n) {
  // Toán tử % cho phần dư của phép chia. Số chẵn chia 2 dư 0.
  // === so sánh bằng, kết quả là true hoặc false
  return n % 2 === 0;
}

console.log(isEven(4), isEven(7)); // true false
