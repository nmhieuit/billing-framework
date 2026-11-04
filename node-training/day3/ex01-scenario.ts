// Không sửa file này. Đọc code rồi đoán thứ tự in ra ở ex01-predict.ts.
export async function scenario(): Promise<string[]> {
  // logs ghi lại thứ tự các chữ cái được "in" ra
  const logs: string[] = [];
  function log(text: string) {
    logs.push(text);
  }

  // 1. Code đồng bộ chạy ngay, theo thứ tự từ trên xuống
  log('A');

  // 2. setTimeout: xếp vào hàng đợi "macrotask", chạy SAU khi code hiện tại và microtask xong
  setTimeout(function () {
    log('B');
  }, 0);

  // 3. Promise.then: xếp vào hàng đợi "microtask", chạy ngay sau code đồng bộ, TRƯỚC macrotask
  Promise.resolve().then(function () {
    log('C');
  });

  // 4. Vẫn là code đồng bộ
  log('D');

  // Chờ 20ms để chắc chắn mọi thứ ở trên đã chạy xong rồi mới trả về kết quả
  await new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
  return logs;
}
