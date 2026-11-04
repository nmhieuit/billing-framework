// Bài 9 (Sửa lỗi): try/catch không bắt được lỗi.
// loadOrDefault(load, fallback): nếu load() thất bại thì trả về fallback.
// Lỗi gốc: viết "return load()" thiếu await nên Promise bị reject đi thẳng ra ngoài, catch không bắt được.
// Bản sửa: "return await load()".

export async function loadOrDefault(load: () => Promise<number>, fallback: number): Promise<number> {
  try {
    // Phải có await thì lỗi của load() mới rơi vào catch bên dưới
    return await load();
  } catch {
    // Có lỗi: trả về giá trị dự phòng
    return fallback;
  }
}
