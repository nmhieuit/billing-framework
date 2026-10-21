// Bài 9 (Sửa lỗi): try/catch không bắt được lỗi.
// loadOrDefault(load, fallback): nếu load() thất bại thì trả về fallback.
// Test đang đỏ vì lỗi vẫn "lọt" ra ngoài. Tìm xem thiếu từ khóa gì (chỉ sửa 1 chỗ).
export async function loadOrDefault(load: () => Promise<number>, fallback: number): Promise<number> {
  try {
    return load();
  } catch {
    return fallback;
  }
}
