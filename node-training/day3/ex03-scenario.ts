// Không sửa file này. Đọc code rồi đoán thứ tự ở ex03-predict.ts.
export async function scenario(): Promise<string[]> {
  const logs: string[] = [];
  const log = (text: string) => logs.push(text);

  async function task() {
    log('1');
    await Promise.resolve();
    log('2');
  }

  log('3');
  setTimeout(() => log('4'), 0);
  const running = task();
  Promise.resolve().then(() => log('5'));
  log('6');

  await running;
  await new Promise((resolve) => setTimeout(resolve, 20));
  return logs;
}
