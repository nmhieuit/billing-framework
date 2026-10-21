// Bài 7 (Nâng cao): hai yêu cầu CÙNG key đến CÙNG LÚC (khi work còn đang chạy bất đồng bộ).
// createSingleFlight() trả về { run(key, work) } với work: () => Promise<T>:
//   - nếu key đang chạy hoặc đã chạy xong thành công: dùng lại kết quả, KHÔNG gọi work lần nữa
//   - nếu work thất bại: quên key này (để lần sau được thử lại) và ném lại lỗi cho người gọi
// Gợi ý: lưu chính PROMISE vào Map NGAY khi bắt đầu (trước khi await), đừng chờ có kết quả mới lưu.
export function createSingleFlight() {
  // TODO
  return {
    run<T>(key: string, work: () => Promise<T>): Promise<T> {
      void key;
      void work;
      return Promise.reject(new Error('TODO'));
    },
  };
}
