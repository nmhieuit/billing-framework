// Bài lab Ngày 2. Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/event-loop.ts
// (Windows PowerShell: .\node_modules\.bin\tsx docs/training/nodejs-1-tuan/labs/event-loop.ts)
// Đoán thứ tự in ra TRƯỚC khi chạy, rồi đối chiếu.
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

console.log('A: đồng bộ');
setTimeout(() => console.log('B: timer 0ms'), 0);
void Promise.resolve().then(() => console.log('C: microtask'));
await sleep(10);
console.log('D: sau await');
