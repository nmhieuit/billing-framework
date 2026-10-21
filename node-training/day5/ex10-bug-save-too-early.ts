// Bài 10 (Sửa lỗi, nâng cao): yêu cầu thất bại làm "kẹt" key mãi mãi.
// Lần gọi đầu thất bại (work ném lỗi); gọi lại cùng key, work chạy được nhưng kết quả vẫn là "thất bại cũ".
// Chạy `pnpm test day5/ex10`, đọc lỗi. Hỏi: khi nào mới nên GHI NHỚ key? (chỉ sửa vị trí 1 dòng)
export function createRunner() {
  const saved = new Map<string, unknown>();
  return {
    run<T>(key: string, work: () => T): T {
      if (saved.has(key)) {
        return saved.get(key) as T;
      }
      saved.set(key, undefined);
      const result = work();
      saved.set(key, result);
      return result;
    },
  };
}
