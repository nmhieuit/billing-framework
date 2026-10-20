// Bài lab Ngày 2: "Nhà hàng một đầu bếp" = Node một luồng.
// Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/event-loop-restaurant.ts
// Đoán thứ tự TRƯỚC khi chạy. Kịch bản 1 chạy trong callback I/O (giống một request HTTP đến).
import { readFile } from 'node:fs';

const t0 = Date.now();
const log = (msg: string): void => console.log(`+${String(Date.now() - t0).padStart(3)}ms  ${msg}`);

// Một món có bước sau `await`: phần sau await luôn là MICROTASK.
async function nauMon(mon: string): Promise<void> {
  log(`[đồng bộ]   bắt đầu nấu ${mon}`);
  await Promise.resolve(); // "gửi kho lấy nguyên liệu" - kho trả lời ngay
  log(`[microtask] ${mon}: nguyên liệu về, nấu tiếp (phần sau await)`);
}

function kichBan1(): Promise<void> {
  return new Promise((xong) => {
    // Khách bước vào = một callback I/O (macrotask), như request HTTP đến.
    readFile(new URL(import.meta.url), () => {
      log('--- KHÁCH VÀO (callback I/O, đang chạy trên đầu bếp) ---');
      setTimeout(() => log('[macrotask: timers]  chuông hẹn giờ 0ms'), 0);
      setImmediate(() => {
        log('[macrotask: check]   setImmediate');
        xong();
      });
      process.nextTick(() => log('[nextTick]   việc khẩn của bếp trưởng'));
      void Promise.resolve().then(() => {
        log('[microtask] Promise.then #1');
        queueMicrotask(() => log('[microtask] microtask do microtask sinh ra (vẫn chen trước macrotask)'));
      });
      queueMicrotask(() => log('[microtask] queueMicrotask'));
      void nauMon('phở');
      log('[đồng bộ]   hết phần đồng bộ của callback khách vào');
    });
  });
}

// Kịch bản 2: vì sao cần macrotask? 100000 bước nối đuôi bằng microtask CHẶN timer;
// nối bằng setImmediate (macrotask) thì timer chen vào được.
async function kichBan2(): Promise<void> {
  const N = 100_000;
  for (const kieu of ['microtask', 'macrotask'] as const) {
    let buoc = 0;
    let timerChayODauBuoc = -1;
    setTimeout(() => {
      timerChayODauBuoc = buoc;
    }, 0);
    await new Promise<void>((xong) => {
      const lam = (): void => {
        buoc += 1;
        if (buoc >= N) return xong();
        if (kieu === 'microtask') queueMicrotask(lam);
        else setImmediate(lam);
      };
      lam();
    });
    await new Promise((r) => setTimeout(r, 5)); // chờ timer (nếu chưa chạy) chạy nốt
    log(`Nối ${N} bước bằng ${kieu}: timer 0ms chạy khi đã xong ${timerChayODauBuoc}/${N} bước`);
  }
}

await kichBan1();
await new Promise((r) => setTimeout(r, 5));
console.log('');
await kichBan2();
