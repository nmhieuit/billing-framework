// Không sửa file này. Đọc code rồi đoán thứ tự ở ex03-predict.ts.
export async function scenario(): Promise<string[]> {
  const logs: string[] = [];
  function log(text: string) {
    logs.push(text);
  }

  // Hàm async: chạy đồng bộ cho đến khi gặp await đầu tiên
  async function task() {
    log('1');
    // Gặp await: tạm dừng task, phần code phía sau được xếp hàng như một microtask
    await Promise.resolve();
    log('2');
  }

  log('3');

  // Macrotask: chạy sau cùng
  setTimeout(function () {
    log('4');
  }, 0);

  // Gọi task(): in '1' ngay, rồi dừng ở await và quay lại đây
  const running = task();

  // Microtask xếp hàng SAU phần "log('2')" của task
  Promise.resolve().then(function () {
    log('5');
  });

  log('6');

  await running;
  // Chờ thêm để setTimeout ở trên chắc chắn đã chạy
  await new Promise(function (resolve) {
    setTimeout(resolve, 20);
  });
  return logs;
}
