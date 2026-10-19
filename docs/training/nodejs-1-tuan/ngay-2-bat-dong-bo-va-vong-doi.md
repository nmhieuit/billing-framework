# Ngày 2: Bất đồng bộ, event loop và vòng đời process

Khung 4 giờ: Chuẩn bị 15' · Lý thuyết 75' · Đọc code 60' · Thực hành 60' · Thử thách 15' · Kiểm tra 15'.

## Mục tiêu hôm nay
- Giải thích event loop, microtask, `Promise`, `async/await` và vì sao Node một luồng vẫn phục vụ nhiều việc.
- Đọc hiểu `Worker`, `startOrExit`, `createShutdownHandler`, `runAll`, `once`, `drainBatches`.
- Mô tả trình tự **khởi động** và **tắt êm** của wallet (từ `main.ts` đến `stop()` trong `bootstrap.ts`).
- Đặt breakpoint đầu tiên trong VS Code. [CHƯA CHẠY: không có VS Code ở môi trường biên soạn]

## Chuẩn bị
`git switch -c hoc/ngay-2`. Đảm bảo `corepack pnpm install` đã chạy (Ngày 1).

## Lý thuyết

### 1. Event loop (vòng lặp sự kiện)
- Code JS của bạn chạy trên **một luồng**. I/O (mạng, DB, file) được giao cho hệ điều hành/libuv; khi xong, callback được đưa lại luồng chính.
- Hai hàng đợi cần phân biệt: **macrotask** (timer `setTimeout`, I/O callback) và **microtask** (callback của `Promise.then`, `await`). Microtask chạy hết **trước** khi sang macrotask kế.
- Hệ quả: một vòng lặp tính toán nặng, đồng bộ sẽ **chặn toàn bộ process** (không có thread khác phục vụ request).
- Lab: [labs/event-loop.ts](labs/event-loop.ts). Đoán thứ tự rồi chạy:
  ```powershell
  .\node_modules\.bin\tsx docs/training/nodejs-1-tuan/labs/event-loop.ts
  ```
  [ĐÃ CHẠY] thứ tự in: `A: đồng bộ`, `C: microtask`, `B: timer 0ms`, `D: sau await`.

### 2. Promise và async/await so với Task
| Khía cạnh | JS `Promise` | C# `Task` (gần đúng) |
| --------- | ------------ | -------------------- |
| Bắt đầu chạy | ngay khi tạo | `Task` từ `async` method cũng bắt đầu ngay; điểm giống |
| Luồng | cùng một luồng chính | thường có thread pool |
| Hủy | `AbortSignal` | `CancellationToken` |
| Lỗi | `throw` trong `async` → promise rejected; `try/catch` quanh `await` | tương tự |
Cạm bẫy: **promise bị bỏ quên** (không `await`) — lỗi trong đó không được bắt ở nơi gọi. Repo ghi rõ ý định bằng `void` (ví dụ `void reply.code(...)`, `wallets.controller.ts:38`) và `await` đầy đủ ở nơi cần.

### 3. Vòng đời process Node
- `process.on('SIGINT' | 'SIGTERM')` bắt tín hiệu tắt (`services/wallet/src/main.ts:57-58`). Trên Docker, `docker stop` gửi SIGTERM.
- `process.exit(code)` thoát ngay. Repo truyền nó như tham số `exit` để test được (`lifecycle.ts:28`).

## Đọc code có hướng dẫn (theo thứ tự)
1. `services/wallet/src/main.ts` (58 dòng):
   - dòng 9-20: đọc cấu hình, lỗi `ConfigError` → log + `process.exit(1)` ("refusing to start");
   - dòng 25-30: `startOrExit` khởi động rồi `listen`;
   - dòng 37-56: `createShutdownHandler`, trong `finally` luôn xả telemetry nhưng chặn tối đa 5 giây (`Promise.race`);
   - dòng 57-58: đăng ký SIGINT/SIGTERM.
   *Hỏi*: nếu `service.stop()` ném lỗi thì telemetry còn được xả không? (xem `finally`, dòng 41)
2. `packages/runtime/src/lifecycle.ts`:
   - `runAll` (dòng 2-12): chạy mọi bước kể cả khi có bước lỗi, cuối cùng ném lỗi **đầu tiên**;
   - `once` (dòng 15-18): `??=` đảm bảo hàm chỉ chạy một lần, lần sau trả cùng promise;
   - `createShutdownHandler` (dòng 32-46): cờ `shuttingDown` bỏ qua tín hiệu thứ hai;
   - `startOrExit` (dòng 59-79): lỗi khi khởi động → `service.stop()` rồi `exit(1)`.
3. `packages/runtime/src/worker.ts` (51 dòng): vòng lặp nền.
   - `#inflight` giữ promise của tick đang chạy; `stop()` `await this.#inflight` (dòng 49) để tắt êm;
   - `loop` đặt `setTimeout` **sau khi** tick xong (dòng 38-40) nên **không bao giờ chồng hai tick**;
   - lỗi trong task đi vào `onError`, và `onError` hỏng cũng không giết vòng lặp (dòng 21-29).
4. `packages/runtime/src/drain.ts`: `drainBatches` dọn theo lô, dừng khi lô nhỏ hơn `batchSize` hoặc `shouldContinue()` false.
5. `services/wallet/src/bootstrap.ts`:
   - dòng 259-264: `new Worker({ tasks: [submitDueForAllTenants, relayOutboxForAllTenants] })`; dòng 267-272 `reconcileWorker` riêng (comment dòng 265-266 giải thích vì sao tách);
   - dòng 314-331: `stop: once(() => runAll([...]))` — **thứ tự tắt**: `broker.stopConsuming` → các worker → `app.close` → `submitter.drain` → `background.drain` → `broker.close` → `db.destroy`.
   *Hỏi*: vì sao dừng consumer trước, đóng DB sau cùng?
6. `packages/observability/src/correlation.ts`: `AsyncLocalStorage` giữ `correlationId` xuyên chuỗi `await` (≈ `AsyncLocal<T>`); `runWithCorrelation` ở `correlation.middleware.ts:14`.

## Thực hành
1. **Đọc test như đặc tả**: mở `packages/runtime/src/worker.test.ts`, chạy `corepack pnpm vitest run packages/runtime` (3 file, 29 test) [ĐÃ CHẠY].
2. **Phá thử để hiểu vai trò dòng 49**: trong `worker.ts` đổi dòng 49 `await this.#inflight;` thành comment, chạy lại. Kết quả mong đợi [ĐÃ CHẠY]: đúng 1 test fail — `Worker > stop() waits for the tick that is running`. Hoàn tác bằng `git restore packages/runtime/src/worker.ts`.
3. **Thêm tính năng**: thêm vào `Worker` một getter `get isRunning(): boolean` trả `this.#running`; viết một test trong `worker.test.ts` kiểm `false` → `true` sau `start()` → `false` sau `await stop()`. Chạy test, `typecheck`, `lint`.
4. **Breakpoint đầu tiên** [CHƯA CHẠY]: trong VS Code mở một terminal bằng lệnh *JavaScript Debug Terminal* (Command Palette), chạy `corepack pnpm vitest run packages/runtime`, đặt breakpoint ở dòng `await task(signal)` (`worker.ts:22`). Quan sát call stack và biến `signal`. Nếu debugger không dừng, ghi lại triệu chứng để hỏi đội dev.
5. **Dựng sơ đồ trình tự tắt** của wallet trên giấy từ `bootstrap.ts:314-331`, đánh dấu bước nào chờ việc đang chạy (gợi ý: `worker.stop`, `consumer.stop`).

## Thử thách troubleshoot
**Triệu chứng**: service nhận SIGTERM nhưng treo ~5 giây mới thoát, log có `shutting down` và sau đó mới `exit`.
Tự lần theo: (a) code nào đặt giới hạn 5 giây? (b) nó chờ cái gì? (c) khi nào thì giới hạn đó có hiệu lực?
*Gợi ý*: `main.ts:42-52`.
*Đáp án*: `telemetry.shutdown()` đua với timer 5 giây bằng `Promise.race`; nếu exporter telemetry không phản hồi (collector không sẵn sàng) thì tối đa 5 giây rồi vẫn thoát (`main.ts:42-52`). Lưu ý `stop()` của service chạy **trước** `finally`, nên nếu chính `stop()` chậm (chờ handler, DB) thì phần đó nằm ngoài giới hạn 5 giây.

## Kiểm tra cuối ngày
1. In ra gì và vì sao (lab event-loop)?
2. Vì sao `Worker` không bao giờ chạy chồng hai tick?
3. `runAll` khác vòng `for...await` thường ở điểm nào về xử lý lỗi?
4. `once` giải quyết vấn đề gì khi nhận hai tín hiệu tắt?
5. Vì sao `main.ts` truyền `exit: (code) => process.exit(code)` thay vì gọi trực tiếp?
6. Nếu bạn viết một vòng `for` đồng bộ chạy 10 giây trong một handler HTTP, điều gì xảy ra với các request khác?
7. `AsyncLocalStorage` ở đây dùng để làm gì?

### Đáp án
1. A, C, B, D: đồng bộ → microtask → macrotask (timer) → code sau `await`. Microtask chạy trước timer.
2. `setTimeout(loop)` chỉ được đặt trong `.finally` của tick trước (`worker.ts:38-40`).
3. `runAll` chạy hết mọi bước rồi mới ném lỗi đầu tiên (`lifecycle.ts:2-12`); `for...await` không bắt sẽ dừng ở lỗi đầu và bỏ các bước đóng còn lại.
4. `once` trả cùng promise cho mọi lần gọi (`lifecycle.ts:15-18`); `bootstrap.ts:316` bọc `stop` bằng `once`, và `createShutdownHandler` có cờ `shuttingDown` (`lifecycle.ts:33-36`).
5. Để test được mà không thoát process thật (`ShutdownOptions.exit`, `lifecycle.ts:28`).
6. Mọi request khác bị chặn vì chỉ có một luồng chạy JS (khác ASP.NET Core thread pool).
7. Lan truyền `x-correlation-id` xuyên các `await`, logger tự gắn vào log (`correlation.ts`, `logger.ts:7-10`).

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Dùng `.Result`/`.Wait()` tương tự bằng vòng chờ đồng bộ: trong Node không có cách chờ đồng bộ một promise; mọi thứ đi qua `await`.
- Tính toán nặng trong request handler làm treo cả process.
- Quên `await` → lỗi không được bắt, kết quả chưa sẵn sàng.

## Câu hỏi còn mở (cho đội dev)
- Cơ chế `stop()` có hủy request HTTP đang bay của `app.close()` hay chờ hết? (tác giả chưa đọc hành vi của NestJS/Fastify trong repo này.)
- Thời gian tối đa của toàn bộ trình tự tắt so với `terminationGracePeriod`/`docker stop -t` — repo chưa thấy cấu hình production (xem Ngày 1).


## Bổ sung: đi theo endpoint `GET /wallet` (đồng bộ, bất đồng bộ, microtask)

Lab chạy được, dùng **code thật** của `GetWallet` với DB giả: [labs/get-wallet-async.ts](labs/get-wallet-async.ts).

```powershell
.\node_modules\.bin\tsx docs/training/nodejs-1-tuan/labs/get-wallet-async.ts
```

Đường đi của `GET /wallet` trong code: Fastify (qua Nest) → `CorrelationMiddleware` (`correlation.middleware.ts:11-15`) → `CallerGuard.canActivate` (`caller.guard.ts`, **đồng bộ**) → `WalletsController.get` (`wallets.controller.ts:42-45`) → `GetWallet.execute` (`get-wallet.ts:35-41`, `async`) → `uow.run` (`unit-of-work.ts:22-40`) → `accounts.find` (`account.repository.ts:16-23`) → SQL qua socket (I/O).

Thứ tự in ra [ĐÃ CHẠY 4 lần, ổn định]:

| Thứ tự | Dòng | Loại |
| --- | --- | --- |
| 1 | `A`, `req1` vào handler, `[uow.run] mở transaction`, `req2` vào handler, `[uow.run] mở transaction`, `B`, `G` | đồng bộ: mỗi request chạy tới `await` đầu tiên rồi trả quyền |
| 2 | `D: queueMicrotask`, `E: Promise.then` | microtask |
| 3 | `C: process.nextTick` | nextTick (xem ghi chú) |
| 4 | `F: setTimeout 0ms` | macrotask |
| 5 | `[accounts.find]` của req1 rồi req2 (cách nhau ~1ms, sau ~20ms) | cả hai request chạy xen kẽ trên một luồng |
| 6 | `req1`/`req2: nhận kết quả` | phần code sau `await` (microtask) |

Ghi chú: ở file này `nextTick` in **sau** microtask vì file là module ESM có top-level `await`, đang chạy bên trong một job microtask. Trong callback I/O thông thường của Node, `nextTick` chạy **trước** promise microtask. Đây là quan sát từ lab + hiểu biết về Node, chưa kiểm chứng riêng trong callback I/O.


## Bổ sung: "nhà hàng một đầu bếp" — thứ tự của mọi lệnh runtime

Lab: [labs/event-loop-restaurant.ts](labs/event-loop-restaurant.ts). Kịch bản 1 chạy trong callback I/O (giống request HTTP đến). Thứ tự [ĐÃ CHẠY 3 lần, ổn định]:

| # | Lệnh | Loại |
| - | ---- | ---- |
| 1 | code đồng bộ trong callback (kể cả phần trước `await` đầu tiên) | đồng bộ |
| 2 | `process.nextTick` | nextTick |
| 3 | `Promise.then`, `queueMicrotask`, phần sau `await`, microtask do microtask sinh ra | microtask |
| 4 | `setImmediate` | macrotask (pha check) |
| 5 | `setTimeout(…, 0)` | macrotask (pha timers) |

Kịch bản 2 [ĐÃ CHẠY 3 lần]: nối 100000 bước bằng microtask thì timer 0ms chạy sau khi xong 100000/100000 bước (bị chặn hoàn toàn); nối bằng `setImmediate` thì timer chen vào sau 8–171 bước (số bước thay đổi mỗi lần chạy).

Trong repo: phần sau `await` là microtask (`get-wallet.ts:36→39`); `Worker` đặt tick kế tiếp bằng `setTimeout` (macrotask, `worker.ts:38-40`) để nhường lượt cho HTTP và consumer.


## Bổ sung: các hàm bất đồng bộ trong luồng nạp tiền thật (wallet → payment)

Lab chạy được, dùng code thật `RequestTopup`, `InlineTopupSubmitter`, `createShutdownHandler`: [labs/topup-async-flow.ts](labs/topup-async-flow.ts).

**Phát hiện [ĐÃ CHẠY `grep` trên mã nguồn không phải test]:** `process.nextTick`, `queueMicrotask`, `setImmediate`, `setInterval` **không có ở đâu** trong `packages/`, `services/`, `db/`, `tools/`. Repo chỉ dùng `await`, `.then/.catch/.finally`, `new Promise`, `Promise.race/allSettled`, `setTimeout`, `AbortSignal`.

| Công cụ | Chỗ dùng thật trong luồng tiền | Vai trò |
| ------- | ------------------------------ | ------- |
| `await` | `request-topup.ts:80,85`; `http-payment-gateway.ts:22`; `deliver-due-webhooks.ts:52,61,63` | chờ DB/HTTP; phần sau `await` là microtask |
| `.catch/.finally` | `inline-topup-submitter.ts:18-30` | việc nền "gửi sang payment" không được làm hỏng request, không để lại rejection chưa xử lý |
| `.then(ok, err)` | `lifecycle.ts:38` | sau khi `stop()` xong thì `exit(0)`, lỗi thì `exit(1)` |
| `.then(task, task)` | `client.ts:185` | xếp hàng tác vụ tuần tự (chuỗi promise làm hàng đợi) |
| `new Promise` + `setTimeout` | `main.ts:44-46` (cả hai service), `client.ts:165-167`, `payment/app.ts:24` | tạo hạn chót; sleep |
| `Promise.race` | `main.ts:48`, `client.ts:163` | "xong hoặc hết giờ, cái nào trước" |
| `Promise.allSettled` | `inline-topup-submitter.ts:35`, `consumer.ts:193`, `background-runs.ts:30` | chờ mọi việc đang chạy dù có lỗi |
| `setTimeout` (loop) | `worker.ts:39` | nhường lượt giữa các tick |
| `AbortSignal.timeout` | `http-payment-gateway.ts:34`, `http-webhook-sender.ts:31` | hạn chót cho `fetch` |

Kết quả lab [ĐÃ CHẠY]: client nhận `202` ngay sau `COMMIT`, ~60ms **trước** khi payment trả lời; payment chết thì client vẫn nhận `202` và lỗi chỉ được log; khi tắt dịch vụ, `drain()` chờ lần gửi đang chạy rồi `.then` mới gọi `exit(0)`.
