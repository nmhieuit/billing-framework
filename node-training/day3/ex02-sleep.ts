// Bài 2 (Cơ bản): tự viết hàm "chờ".
// sleep(ms) trả về một Promise, hoàn thành (resolve) sau ms mili-giây, không có giá trị.
// Cách dùng: await sleep(100);

export function sleep(ms: number): Promise<void> {
  // new Promise nhận một hàm có tham số resolve.
  // Khi gọi resolve(), Promise được coi là "hoàn thành" và await phía ngoài mới chạy tiếp
  return new Promise(function (resolve) {
    // setTimeout gọi resolve sau ms mili-giây
    setTimeout(function () {
      resolve();
    }, ms);
  });
}
