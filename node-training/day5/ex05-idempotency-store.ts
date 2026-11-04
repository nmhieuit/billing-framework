// Bài 5 (Trung bình): bộ nhớ "Idempotency-Key" (chống xử lý trùng).
// createIdempotencyStore() trả về đối tượng có hàm run(key, fingerprint, work):
//   - key mới: gọi work() (đồng bộ, trả về giá trị), nhớ kết quả, trả { result, replayed: false }
//   - key đã có và fingerprint GIỐNG: KHÔNG gọi work nữa, trả kết quả đã nhớ { result, replayed: true }
//   - key đã có nhưng fingerprint KHÁC: throw new Error('IDEMPOTENCY_KEY_REUSED')
// fingerprint là chuỗi "dấu vân tay" của nội dung yêu cầu (ví dụ JSON.stringify(body)).

// Kết quả của một lần run. <T> là kiểu của result (generic: kiểu do người dùng hàm quyết định)
export interface RunOutcome<T> {
  result: T; // kết quả của work
  replayed: boolean; // true nếu đây là kết quả cũ được trả lại
}

// Thông tin lưu lại cho mỗi key
interface SavedEntry {
  fingerprint: string;
  result: unknown;
}

export function createIdempotencyStore() {
  // Bộ nhớ: key -> { fingerprint, result } của lần chạy đầu tiên
  const saved = new Map<string, SavedEntry>();

  function run<T>(key: string, fingerprint: string, work: () => T): RunOutcome<T> {
    const entry = saved.get(key);

    // Trường hợp 1: key mới -> chạy work(), nhớ kết quả
    if (entry === undefined) {
      const result = work();
      saved.set(key, { fingerprint: fingerprint, result: result });
      return { result: result, replayed: false };
    }

    // Trường hợp 2: key đã có, fingerprint giống -> trả kết quả đã nhớ, không gọi work()
    if (entry.fingerprint === fingerprint) {
      return { result: entry.result as T, replayed: true };
    }

    // Trường hợp 3: key đã có, fingerprint khác -> cùng key mà nội dung khác nên báo lỗi
    throw new Error('IDEMPOTENCY_KEY_REUSED');
  }

  return { run: run };
}
