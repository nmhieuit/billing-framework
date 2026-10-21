// Bài 2 (Cơ bản): tự viết hàm "chờ".
// sleep(ms) trả về một Promise, hoàn thành (resolve) sau ms mili-giây, không có giá trị.
// Cách dùng: await sleep(100);
export function sleep(ms: number): Promise<void> {
  // TODO: return new Promise(...) + setTimeout
  return Promise.resolve();
}
