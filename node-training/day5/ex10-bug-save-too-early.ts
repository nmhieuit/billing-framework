// Bài 10 (Sửa lỗi, nâng cao): yêu cầu thất bại làm "kẹt" key mãi mãi.
// Lỗi gốc: ghi nhớ key TRƯỚC khi work chạy xong, nên work thất bại rồi mà key vẫn bị coi là đã xử lý.
// Bản sửa: chỉ ghi nhớ key SAU KHI work chạy thành công (work ném lỗi thì dòng set không được chạy).

export function createRunner() {
  // key -> kết quả của lần chạy thành công
  const saved = new Map<string, unknown>();

  return {
    run(key: string, work: () => unknown): unknown {
      // Đã có kết quả thành công cho key này: dùng lại
      if (saved.has(key)) {
        return saved.get(key);
      }

      // Chạy work. Nếu work ném lỗi thì hàm dừng ngay ở dòng này, chưa lưu gì cả
      const result = work();

      // Thành công mới ghi nhớ
      saved.set(key, result);
      return result;
    },
  };
}
