// Không sửa file này. Đọc code rồi đoán thứ tự in ra ở ex01-predict.ts.
export async function scenario(): Promise<string[]> {
  const logs: string[] = [];
  const log = (text: string) => logs.push(text);

  log('A');
  setTimeout(() => log('B'), 0);
  Promise.resolve().then(() => log('C'));
  log('D');

  await new Promise((resolve) => setTimeout(resolve, 20));
  return logs;
}
