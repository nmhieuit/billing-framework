// Bài 7 (Nâng cao): hai yêu cầu CÙNG key đến CÙNG LÚC (khi work còn đang chạy bất đồng bộ).
// createSingleFlight() trả về { run(key, work) } với work: () => Promise<T>:
//   - nếu key đang chạy hoặc đã chạy xong thành công: dùng lại kết quả, KHÔNG gọi work lần nữa
//   - nếu work thất bại: quên key này (để lần sau được thử lại) và ném lại lỗi cho người gọi
// Mấu chốt: lưu chính PROMISE vào Map NGAY khi bắt đầu (trước khi await),
// để lời gọi thứ hai đến sau thấy ngay và dùng chung, không chờ có kết quả mới lưu.

export function createSingleFlight() {
  // key -> Promise của lần chạy (đang chạy hoặc đã xong)
  const flights = new Map<string, Promise<unknown>>();

  async function run<T>(key: string, work: () => Promise<T>): Promise<T> {
    // Key đã có (đang chạy hoặc đã xong): dùng lại Promise cũ, không gọi work nữa
    const existing = flights.get(key);
    if (existing !== undefined) {
      return existing as Promise<T>;
    }

    // Key mới: gọi work() để bắt đầu chạy, lưu Promise NGAY (chưa await)
    const promise = work();
    flights.set(key, promise);

    try {
      // Chờ kết quả; thành công thì trả ra
      return await promise;
    } catch (error) {
      // Thất bại: quên key để lần sau được thử lại, rồi ném lỗi tiếp cho người gọi
      flights.delete(key);
      throw error;
    }
  }

  return { run };
}
