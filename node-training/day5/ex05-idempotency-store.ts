// Bài 5 (Trung bình): bộ nhớ "Idempotency-Key" (chống xử lý trùng).
// createIdempotencyStore() trả về đối tượng có hàm run(key, fingerprint, work):
//   - key mới: gọi work() (đồng bộ, trả về giá trị), nhớ kết quả, trả { result, replayed: false }
//   - key đã có và fingerprint GIỐNG: KHÔNG gọi work nữa, trả kết quả đã nhớ { result, replayed: true }
//   - key đã có nhưng fingerprint KHÁC: throw new Error('IDEMPOTENCY_KEY_REUSED')
// fingerprint là chuỗi "dấu vân tay" của nội dung yêu cầu (ví dụ JSON.stringify(body)).
export interface RunOutcome<T> {
  result: T;
  replayed: boolean;
}

export function createIdempotencyStore() {
  // TODO: const saved = new Map<string, { fingerprint: string; result: unknown }>();
  return {
    run<T>(key: string, fingerprint: string, work: () => T): RunOutcome<T> {
      void key;
      void fingerprint;
      void work;
      throw new Error('TODO');
    },
  };
}
