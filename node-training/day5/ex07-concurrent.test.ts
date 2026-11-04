import { expect, test } from 'vitest';
import { createSingleFlight } from './ex07-concurrent.js';

// Hàm chờ ms mili-giây
function sleep(ms: number) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

test('hai lời gọi đồng thời cùng key: work chỉ chạy một lần', async () => {
  const flight = createSingleFlight();
  let calls = 0;
  async function work() {
    calls = calls + 1;
    await sleep(30); // giả lập công việc chạy lâu
    return 'ok';
  }

  // Gọi 3 lần cùng lúc (chưa chờ) rồi Promise.all chờ cả 3
  const results = await Promise.all([flight.run('k', work), flight.run('k', work), flight.run('k', work)]);
  expect(results).toEqual(['ok', 'ok', 'ok']);
  expect(calls).toBe(1);
});

test('gọi lại sau khi xong: vẫn dùng kết quả cũ', async () => {
  const flight = createSingleFlight();
  let calls = 0;
  async function work() {
    calls = calls + 1;
    return calls;
  }
  expect(await flight.run('k', work)).toBe(1);
  expect(await flight.run('k', work)).toBe(1);
});

test('key khác nhau chạy riêng', async () => {
  const flight = createSingleFlight();
  expect(await flight.run('a', async () => 'A')).toBe('A');
  expect(await flight.run('b', async () => 'B')).toBe('B');
});

test('work thất bại: lỗi được trả ra và lần sau được thử lại', async () => {
  const flight = createSingleFlight();
  let calls = 0;
  // Lần gọi đầu báo lỗi, lần sau thành công
  async function flaky() {
    calls = calls + 1;
    if (calls === 1) {
      throw new Error('lan dau hong');
    }
    return 'lan hai ok';
  }
  await expect(flight.run('k', flaky)).rejects.toThrow('lan dau hong');
  expect(await flight.run('k', flaky)).toBe('lan hai ok');
  expect(calls).toBe(2);
});
