# Ngày 6: Độ tin cậy khi gọi service khác, và debug bằng VS Code

> Thời lượng: 4 giờ. Hôm nay bạn mô phỏng đúng thứ khó nhất của dự án: **wallet gọi payment**, payment có thể **chậm**, **lỗi** hoặc **từ chối**. Bạn dựng từng mảnh nhỏ (gọi, timeout, thử lại, trạng thái, chạy nền, nhận kết quả trễ) và học dùng **debugger** để tìm lỗi. Ngày 7 bạn sẽ thấy chính các mảnh này trong code thật.

## Mục tiêu

- Gọi một service khác bằng `fetch`; phân biệt ba kết quả: **created** (thành công), **rejected** (bị từ chối, thử lại vô ích), **unavailable** (chậm / lỗi, thử lại được).
- Đặt **timeout** cho lời gọi bằng `AbortSignal.timeout`.
- Thử lại theo bậc (**retry with backoff**) và chỉ thử lại khi đáng thử lại.
- Mô tả vòng đời của một lệnh nạp tiền bằng các trạng thái `REQUESTED` / `PENDING` / `FAILED` / `SUCCEEDED`.
- Trả `202` ngay rồi gửi sang payment ở nền, an toàn khi lỗi; nhận kết quả (webhook) bị gửi trùng hoặc đến muộn.
- Đặt breakpoint, bước từng dòng và xem biến bằng debugger trong VS Code.
- Làm đúng ít nhất 7/10 bài.

## Chuẩn bị (5 phút)

- Đã xong Ngày 5. Tạo thư mục gõ bài: `mkdir hoc\day6`.
- Thư mục `day6/support/` có `fake-payment.ts`: một **payment giả** đã viết sẵn. Mở ra đọc; bạn sẽ dùng nó cả ngày. Nó chạy server Fastify trên cổng ngẫu nhiên và trả lời theo một "kịch bản", ví dụ `['slow']`, `['error', 'error', 'ok']`:

| Hành vi | Payment giả trả lời |
| ------- | ------------------- |
| `'ok'` | `202` kèm `{ chargeId: 'ch_1' }` ngay |
| `'slow'` | Chờ `slowMs` mili-giây rồi mới trả `202` |
| `'error'` | `500` |
| `'reject'` | `422` (từ chối nghiệp vụ) |

- `pnpm test day6` phải **đỏ**.

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Gọi payment bằng `fetch` + Bài 1 | 20 phút |
| 2 | Timeout và ba loại kết quả + Bài 2 | 35 phút |
| 3 | Thử lại theo bậc + Bài 3, 4 | 40 phút |
| 4 | Trạng thái của lệnh nạp + Bài 5 | 25 phút |
| 5 | Chạy nền và nhận kết quả trễ + Bài 6, 7 | 55 phút |
| 6 | Debugger VS Code + Bài 8, 9, 10 | 45 phút |
| 7 | Kiểm tra cuối ngày | 15 phút |

---

## Khối 1: Gọi payment bằng `fetch` (8 phút + Bài 1)

Ba khái niệm mới: **`fetch`** (gọi HTTP từ code), **`response.status` và `response.json()`**, **server giả cho thực hành**.

Gõ `hoc/day6/a-goi-payment.ts`:

```ts
import { startFakePayment } from '../../day6/support/fake-payment.js';

const payment = await startFakePayment(['ok']);

const response = await fetch(`${payment.url}/charges`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ amount: 100 }),
});
console.log(response.status);
console.log(await response.json());

await payment.close();
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3 | Bật payment giả theo kịch bản `['ok']`; nhận về `payment.url` (có cổng ngẫu nhiên) |
| 5-9 | `fetch(url, { method, headers, body })` gọi HTTP, giống `curl` nhưng từ code. Body phải là chuỗi (`JSON.stringify`) |
| 10 | `response.status`: mã trạng thái |
| 11 | `await response.json()`: đọc body thành đối tượng (cũng là Promise nên cần `await`) |
| 13 | Tắt payment giả khi xong, nếu không chương trình không thoát |

```text
$ pnpm tsx hoc/day6/a-goi-payment.ts
202
{ chargeId: 'ch_1' }
```

Lưu ý quan trọng: `fetch` **không ném lỗi** khi server trả `500`; nó chỉ ném lỗi khi **không kết nối được** hoặc bị hủy. Bạn phải tự kiểm tra `status`.

### Bài 1: gọi payment (Cơ bản, 10 phút)

`day6/ex01-call-payment.ts`. Chạy `pnpm test day6/ex01`.

---

## Khối 2: Timeout và ba loại kết quả (15 phút + Bài 2)

Ba khái niệm mới: **timeout bằng `AbortSignal.timeout`**, **kết quả có tên** (`created` / `rejected` / `unavailable`), **vì sao không ném lỗi**.

Nếu payment treo, lời gọi `fetch` của bạn treo theo, request của khách treo theo. Luôn đặt giới hạn thời gian. Gõ `hoc/day6/b-timeout.ts`:

```ts
import { startFakePayment } from '../../day6/support/fake-payment.js';

const payment = await startFakePayment(['slow'], 2000);

const start = Date.now();
try {
  await fetch(`${payment.url}/charges`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount: 100 }),
    signal: AbortSignal.timeout(300),
  });
} catch (error) {
  console.log('lỗi:', (error as Error).name, `sau ${Date.now() - start}ms`);
}

await payment.close();
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3 | Payment giả chậm 2000ms |
| 11 | `signal: AbortSignal.timeout(300)`: sau 300ms thì **hủy** lời gọi |
| 13 | Lỗi bắt được có tên `TimeoutError` |

```text
$ pnpm tsx hoc/day6/b-timeout.ts
lỗi: TimeoutError sau 304ms
```

Lời gọi bị hủy sau khoảng 300ms (không phải 2000ms). Đây đúng là thứ `HttpPaymentGateway` của dự án làm (bạn sẽ đọc ở Ngày 7).

Ba tình huống, ba cách xử lý khác nhau. Gọi payment có thể kết thúc theo ba kiểu, và **người gọi phải biết đúng kiểu nào**:

| Kết quả | Khi nào | Nên làm gì |
| ------- | ------- | ---------- |
| `created` | Payment trả `202` | Ghi nhận, chờ kết quả cuối |
| `rejected` | Payment trả `4xx` (dữ liệu bị từ chối) | **Không** thử lại (vô ích); đánh dấu thất bại |
| `unavailable` | Quá hạn, lỗi mạng, hoặc `5xx` | **Thử lại sau** |

Vì thế hàm gọi payment trả về một **kết quả có tên** thay vì ném lỗi: nơi gọi đỡ phải tự phân loại lỗi.

### Bài 2: cổng gọi payment (Trung bình, 20 phút)

`day6/ex02-gateway.ts`: hàm `createCharge` trả đúng một trong ba kiểu trên và **không bao giờ ném lỗi**. Chạy `pnpm test day6/ex02`. Bài này dùng payment giả thật (server thật trên máy bạn).

---

## Khối 3: Thử lại theo bậc (8 phút + Bài 3, 4)

Ba khái niệm mới: **retry**, **backoff** (chờ lâu dần giữa các lần thử), **truyền hàm `sleep` để test nhanh**.

Lỗi tạm thời (payment bận) thường tự hết. Thử lại ngay lập tức dễ làm nó quá tải thêm, nên chờ **lâu dần**: 1 giây, 5 giây, 30 giây... Gõ `hoc/day6/c-retry.ts`:

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function retry<T>(task: () => Promise<T>, delaysMs: number[]): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay === undefined) {
        throw error;
      }
      console.log(`lần ${attempt + 1} hỏng, chờ ${delay}ms rồi thử lại`);
      await sleep(delay);
    }
  }
}

let calls = 0;
const flaky = async () => {
  calls += 1;
  if (calls < 3) throw new Error('payment unavailable');
  return `thành công ở lần ${calls}`;
};

console.log(await retry(flaky, [100, 200, 400]));
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3 | `retry(task, delaysMs)`: thử `task`, nếu lỗi thì chờ theo danh sách `delaysMs` rồi thử lại |
| 4 | Vòng `for` không có điều kiện dừng: thoát bằng `return` (thành công) hoặc `throw` (hết bậc) |
| 8-11 | `delaysMs[attempt]` là thời gian chờ của lần này; hết danh sách (`undefined`) thì ném lỗi cuối |
| 19-23 | Việc giả: hai lần đầu hỏng, lần ba thành công |

```text
$ pnpm tsx hoc/day6/c-retry.ts
lần 1 hỏng, chờ 100ms rồi thử lại
lần 2 hỏng, chờ 200ms rồi thử lại
thành công ở lần 3
```

Với tổng thời gian chờ có thể lên hàng phút, test không thể chờ thật. Mẹo: **truyền hàm `sleep` vào** để test thay bằng hàm giả không chờ (chỉ ghi lại số mili-giây định chờ). Hai bài tới dùng cách này.

### Bài 3: hàm retry (Trung bình, 15 phút)

`day6/ex03-retry.ts`. Chạy `pnpm test day6/ex03`.

### Bài 4: chỉ thử lại khi đáng thử lại (Trung bình, 15 phút)

`day6/ex04-submit-with-retry.ts`: thử lại khi `unavailable`, dừng ngay khi `created` hoặc `rejected`. Chạy `pnpm test day6/ex04`.

---

## Khối 4: Trạng thái của một lệnh nạp tiền (6 phút + Bài 5)

Ba khái niệm mới: **máy trạng thái** (state machine), **hàm thuần** (không sửa dữ liệu vào, không đụng mạng), **lịch thử lại** (`nextAttemptAt`).

Một lệnh nạp tiền đi qua các trạng thái:

```text
            payment nhận (created)
 REQUESTED ─────────────────────────► PENDING ──► SUCCEEDED / FAILED  (khi payment báo kết quả cuối)
    │  ▲
    │  └── unavailable, còn bậc chờ: vẫn REQUESTED, hẹn lần thử sau (nextAttemptAt)
    │
    ├── rejected ───────────────────► FAILED  (PAYMENT_REJECTED)
    └── unavailable, hết bậc chờ ───► FAILED  (PAYMENT_UNAVAILABLE)
```

`REQUESTED` = chưa gửi được sang payment (hoặc đang chờ thử lại); `PENDING` = payment đã nhận, chờ kết quả cuối. Đặt tên và quy tắc này thành **hàm thuần** `applyOutcome(topup, outcome, now, delays)` trả về lệnh mới giúp dễ test: không cần mạng, không cần đồng hồ thật.

### Bài 5: máy trạng thái (Nâng cao, 20 phút)

`day6/ex05-topup-state.ts`. Chú ý: danh sách chờ `[1, 5, 30]` nghĩa là có **ba lần hẹn thử lại**, lần `unavailable` thứ **bốn** mới là `FAILED`. Chạy `pnpm test day6/ex05`.

---

## Khối 5: Chạy nền và nhận kết quả trễ (8 phút + Bài 6, 7)

Ba khái niệm mới: **trả `202` rồi làm tiếp ở nền**, **theo dõi việc nền để tắt server cho đúng** (`drain`), **webhook trùng / đến muộn**.

Ngày 3 bạn đã gặp "bắn rồi quên". Hôm nay áp dụng vào đúng bài toán: `POST /topups` lưu lệnh, trả **`202 Accepted`** (đã nhận, chưa xong), còn việc gọi payment làm ở nền. Gõ `hoc/day6/d-chay-nen.ts`:

```ts
import Fastify from 'fastify';

const app = Fastify();
const status = new Map<string, string>();
const pending = new Set<Promise<void>>();

const sendToPayment = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

app.post('/topups', async (_request, reply) => {
  const id = `t${status.size + 1}`;
  status.set(id, 'REQUESTED');

  const job = (async () => {
    await sendToPayment();
    status.set(id, 'PENDING');
  })()
    .catch((error) => console.log('lỗi chạy nền:', error))
    .finally(() => pending.delete(job));
  pending.add(job);

  return reply.code(202).send({ id, status: 'REQUESTED' });
});

app.get('/topups/:id', async (request) => {
  const { id } = request.params as { id: string };
  return { id, status: status.get(id) };
});

const first = await app.inject({ method: 'POST', url: '/topups' });
console.log('ngay sau POST :', first.statusCode, first.json());
console.log('hỏi ngay      :', (await app.inject({ method: 'GET', url: '/topups/t1' })).json());
await Promise.all(pending);
console.log('sau khi chờ   :', (await app.inject({ method: 'GET', url: '/topups/t1' })).json());
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 5 | `pending`: tập các việc nền đang chạy |
| 10-11 | Tạo lệnh, trạng thái `REQUESTED` |
| 13-16 | Việc nền: gọi payment (giả lập 200ms) rồi đổi trạng thái thành `PENDING` |
| 17 | `.catch`: lỗi việc nền được ghi log, không làm sập chương trình |
| 18 | `.finally`: xong (dù thành công hay lỗi) thì bỏ khỏi `pending` |
| 21 | Trả `202` **ngay**, không chờ việc nền |
| 32 | `Promise.all(pending)` chờ mọi việc nền xong; dự án gọi thao tác tương tự là `drain()` khi tắt dịch vụ để không cắt ngang giữa chừng |

```text
$ pnpm tsx hoc/day6/d-chay-nen.ts
ngay sau POST : 202 { id: 't1', status: 'REQUESTED' }
hỏi ngay      : { id: 't1', status: 'REQUESTED' }
sau khi chờ   : { id: 't1', status: 'PENDING' }
```

Ngay sau POST lệnh vẫn `REQUESTED`; sau khi việc nền xong mới `PENDING`. Khách hỏi lại (`GET /topups/t1`) sẽ thấy trạng thái tiến triển.

### Bài 6: trả 202 và gửi nền (Nâng cao, 25 phút)

`day6/ex06-background-submit.ts`. Test cố tình giữ việc nền "treo" để kiểm tra bạn **thật sự không chờ**. Chạy `pnpm test day6/ex06`.

### Kết quả cuối đến sau: webhook

Payment báo kết quả cuối bằng cách gọi ngược về wallet (một **webhook**: HTTP do dịch vụ kia chủ động gọi). Hai tình huống thật:

- Payment gửi **trùng** (mạng chập chờn nên gửi lại): wallet không được cộng tiền hai lần. Mỗi webhook có `eventId`; `eventId` đã xử lý thì bỏ qua.
- Wallet đã **bỏ cuộc** (hết bậc thử lại, `FAILED`) nhưng payment vẫn xử lý thành công và báo về sau. Khách đã bị trừ tiền ở payment, nên wallet phải nhận kết quả muộn này (payment mới là nguồn sự thật).

### Bài 7: nhận webhook (Nâng cao, 20 phút)

`day6/ex07-webhook.ts`. Chạy `pnpm test day6/ex07`. Bảy test, mỗi test là một tình huống ở trên; đọc kỹ danh sách quy tắc trong đề.

---

## Khối 6: Debug bằng VS Code (15 phút + Bài 8, 9, 10)

Ba khái niệm mới: **breakpoint**, **bước từng dòng** (step), **xem biến** (variables / watch / call stack).

`console.log` đủ dùng cho việc nhỏ; khi code rối, **debugger** cho bạn dừng chương trình tại một dòng và xem mọi thứ. Thư mục `node-training/.vscode/launch.json` đã có sẵn hai cấu hình:

| Tên trong VS Code | Dùng để |
| ----------------- | ------- |
| `Chạy file đang mở (tsx)` | Chạy file `.ts` đang mở trong debugger |
| `Debug test của file đang mở (vitest)` | Chạy **file test đang mở** trong debugger |

Cách làm với bài 10 (làm ngay bây giờ):

1. Mở **thư mục `node-training`** trong VS Code (`code .` từ thư mục đó) để VS Code nhận `.vscode/launch.json`.
2. Mở `day6/ex10-bug-hunt.ts`, bấm vào lề trái cạnh số dòng của dòng `let succeededTotal = 0;` để đặt **breakpoint** (chấm đỏ).
3. Mở `day6/ex10-bug-hunt.test.ts` (file test **phải là file đang mở**), mở bảng Run and Debug (`Ctrl+Shift+D`), chọn `Debug test của file đang mở (vitest)`, bấm `F5`.
4. Chương trình dừng ở breakpoint. Nhìn khung **VARIABLES** bên trái: các biến cục bộ và giá trị của chúng; khung **CALL STACK**: ai đã gọi hàm này.
5. Điều khiển bằng phím:

| Phím | Làm gì |
| ---- | ------ |
| `F5` | Chạy tiếp đến breakpoint kế |
| `F10` | Chạy **một dòng**, không chui vào hàm được gọi |
| `F11` | Chui vào hàm được gọi ở dòng hiện tại |
| `Shift+F11` | Thoát ra khỏi hàm hiện tại |
| `Shift+F5` | Dừng debug |

6. Thêm biểu thức vào khung **WATCH** (ví dụ `charge.status`) để theo dõi giá trị qua từng bước.

Quy trình săn lỗi: đoán dòng nghi ngờ → đặt breakpoint ngay trước đó → bước từng dòng → so giá trị thật của biến với giá trị bạn **mong đợi** → dòng đầu tiên làm giá trị lệch chính là lỗi.

> Ghi chú của người biên soạn: lệnh chạy test như cấu hình (`node node_modules/vitest/vitest.mjs run <file> --pool=forks --no-file-parallelism`) và việc Node mở cổng debugger (`--inspect-brk`) đã chạy thật trên Linux; thao tác breakpoint trong giao diện VS Code trên Windows **[CHƯA CHẠY]**. Nếu breakpoint không dừng, xem mục "Lỗi thường gặp".

### Bài 8: retry sai số lần (Sửa lỗi, 10 phút)

`day6/ex08-bug-retry-count.ts`. Chạy `pnpm test day6/ex08`. Đọc `expected` / `received` để biết sai lệch bao nhiêu, rồi dò bằng debugger hoặc bằng cách đọc điều kiện vòng lặp.

### Bài 9: payment chậm làm treo (Sửa lỗi, 10 phút)

`day6/ex09-bug-no-timeout.ts`. Chạy `pnpm test day6/ex09`; để ý thời gian test chạy. Thiếu một tham số của `fetch`.

### Bài 10: săn lỗi bằng debugger (Nâng cao, 20 phút)

`day6/ex10-bug-hunt.ts` có **ba lỗi logic**, test đỏ ở ba chỗ. Dùng debugger theo quy trình ở trên, đừng chỉ đọc code. Chạy `pnpm test day6/ex10` để kiểm tra.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-call-payment.ts` | Cơ bản | 10' | `pnpm test day6/ex01` | xanh |
| 2 | `ex02-gateway.ts` | Trung bình | 20' | `pnpm test day6/ex02` | xanh |
| 3 | `ex03-retry.ts` | Trung bình | 15' | `pnpm test day6/ex03` | xanh |
| 4 | `ex04-submit-with-retry.ts` | Trung bình | 15' | `pnpm test day6/ex04` | xanh |
| 5 | `ex05-topup-state.ts` | Nâng cao | 20' | `pnpm test day6/ex05` | xanh |
| 6 | `ex06-background-submit.ts` | Nâng cao | 25' | `pnpm test day6/ex06` | xanh |
| 7 | `ex07-webhook.ts` | Nâng cao | 20' | `pnpm test day6/ex07` | xanh |
| 8 | `ex08-bug-retry-count.ts` | Sửa lỗi | 10' | `pnpm test day6/ex08` | xanh |
| 9 | `ex09-bug-no-timeout.ts` | Sửa lỗi | 10' | `pnpm test day6/ex09` | xanh |
| 10 | `ex10-bug-hunt.ts` | Sửa lỗi (debugger) | 20' | `pnpm test day6/ex10` | xanh |

Chạy cả ngày: `pnpm test day6`. Lời giải: `node-training/solutions/day6/`.

## Gợi ý (mở từng mức)

<details><summary>Bài 1: callPayment</summary>

1. `fetch(\`${url}/charges\`, { method: 'POST', ... })`.
2. Cần `headers: { 'content-type': 'application/json' }` và `body: JSON.stringify({ amount })`.
3. Nếu `response.status !== 202` thì `throw new Error(\`payment responded ${response.status}\`)`; ngược lại `(await response.json()).chargeId`.

</details>

<details><summary>Bài 2: createCharge</summary>

1. Bọc cả `fetch` và đọc body trong `try { ... } catch { return { outcome: 'unavailable' }; }`.
2. Thêm `signal: AbortSignal.timeout(timeoutMs)` vào `fetch`.
3. `202` → `created` (đọc `chargeId`); `400..499` → `rejected` kèm `status`; còn lại → `unavailable`.

</details>

<details><summary>Bài 3: withRetry</summary>

1. Vòng lặp `for (let attempt = 0; ; attempt += 1)` với `try { return await task(); } catch ...`.
2. Trong `catch`: `const delay = delaysMs[attempt]`; `undefined` nghĩa là hết bậc.
3. Hết bậc: `throw error`. Còn bậc: `await sleep(delay)` rồi vòng tiếp.

</details>

<details><summary>Bài 4: submitWithRetry</summary>

1. Lặp `count = 1, 2, ...`, mỗi vòng `await attempt()`.
2. `outcome !== 'unavailable'` → trả ngay `{ ...result, attempts: count }`.
3. `unavailable`: lấy `delaysMs[count - 1]`; `undefined` → trả `{ ...result, attempts: count }`; có thì `await sleep(delay)` rồi lặp.

</details>

<details><summary>Bài 5: applyOutcome</summary>

1. Dùng `if` theo `outcome.outcome`; mỗi nhánh trả một đối tượng mới bằng `{ ...topup, ... }` (không sửa `topup`).
2. `unavailable`: `attempts = topup.attempts + 1`; còn bậc nếu `attempts <= delaysSeconds.length`.
3. Còn bậc: `nextAttemptAt: new Date(now.getTime() + delaysSeconds[attempts - 1] * 1000)`. Hết bậc: `FAILED`, `PAYMENT_UNAVAILABLE`, `nextAttemptAt: null`.

</details>

<details><summary>Bài 6: background submit</summary>

1. Bắt đầu từ `d-chay-nen.ts`.
2. `drain` trả về `Promise.all(pending)` (nhớ bọc để trả `void`).
3. Việc nền: `(async () => { const r = await deps.submit(topup); if (r === 'created') topup.status = 'PENDING'; })().catch((e) => deps.log(\`submit failed: ${e.message}\`)).finally(...)`.

</details>

<details><summary>Bài 7: webhook</summary>

1. Hai kho: `topups` (id → { amount, status }) và `seenEvents` (Set các `eventId`).
2. Thứ tự: `eventId` đã thấy → `'duplicate'`; topup không có → `throw`; đã `SUCCEEDED` → `'ignored'`; còn lại → cập nhật, `'applied'`.
3. `balance()` cộng `amount` của các topup `SUCCEEDED`; nhớ đánh dấu `eventId` đã thấy **sau khi** biết topup tồn tại.

</details>

<details><summary>Bài 8: retryTimes</summary>

1. Đếm xem test mong đợi bao nhiêu lần gọi và hàm đang gọi bao nhiêu lần.
2. `retries = 2` nghĩa là 1 lần đầu + 2 lần thử lại = 3 lần.
3. Điều kiện vòng lặp `attempt < retries` chạy thiếu một lần; đổi thành `<=`.

</details>

<details><summary>Bài 9: no timeout</summary>

1. Test báo chạy quá lâu hoặc kết quả `ok` khi mong đợi `timeout`.
2. Xem lại `b-timeout.ts`.
3. Thêm `signal: AbortSignal.timeout(timeoutMs)` vào tham số thứ hai của `fetch`.

</details>

<details><summary>Bài 10: bug hunt</summary>

1. Bước qua từng vòng lặp, theo dõi `succeededTotal`, `failedCount`, `latest` ở khung VARIABLES.
2. Ba dòng nghi ngờ: cách cộng dồn của `succeededTotal`, điều kiện đếm `failedCount`, và dấu so sánh khi chọn `latest`.
3. `succeededTotal = charge.amount` → phải cộng dồn (`+=`); `status === 'pending'` → phải là `'failed'`; `createdAt < latest.createdAt` → phải là `>`.

</details>

## Kiểm tra cuối ngày (15 phút)

1. Vì sao mọi lời gọi sang service khác phải có timeout?
2. Phân biệt `rejected` và `unavailable`; cái nào được thử lại, vì sao?
3. Vì sao chờ lâu dần (1s, 5s, 30s) thay vì thử lại liên tục?
4. Trả `202` nghĩa là gì? Khách biết kết quả cuối bằng cách nào?
5. Vì sao việc chạy nền luôn cần `.catch`, và `drain()` để làm gì?
6. Webhook trùng và webhook đến muộn cần xử lý ra sao?

<details><summary>Đáp án</summary>

1. Service kia có thể treo; không có timeout, request của bạn treo theo và chiếm tài nguyên.
2. `rejected`: dữ liệu bị từ chối, thử lại sẽ ra kết quả y hệt nên không thử lại. `unavailable`: lỗi tạm thời (chậm, mạng, `5xx`), thử lại có thể thành công.
3. Thử dồn dập làm service đang yếu càng quá tải; chờ lâu dần cho nó thời gian hồi phục.
4. `202 Accepted` = đã nhận, chưa xử lý xong. Khách hỏi lại bằng `GET` (xem trạng thái) hoặc được báo khi có kết quả cuối.
5. Không có `.catch` thì lỗi thành unhandled rejection và có thể làm sập tiến trình. `drain()` chờ các việc nền đang chạy xong để tắt dịch vụ không cắt ngang.
6. Trùng: nhớ `eventId` đã xử lý, bỏ qua lần sau. Đến muộn: nếu payment báo thành công dù wallet đã bỏ cuộc thì vẫn nhận, vì payment là nguồn sự thật.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| Chương trình không thoát sau khi xong | Quên `await payment.close()` | Luôn đóng server giả khi xong |
| Test timeout 5 giây (vitest) | Payment giả `slow` nhưng code không đặt timeout, hoặc test chờ `sleep` thật | Thêm `AbortSignal.timeout`; truyền `sleep` giả |
| `fetch failed` / `ECONNREFUSED` | Địa chỉ sai hoặc server giả đã tắt | In `payment.url` ra kiểm tra |
| Breakpoint hiện chấm xám, không dừng | Không mở đúng file test khi bấm F5, hoặc mở sai thư mục VS Code | Mở thư mục `node-training`; để file `.test.ts` là file đang mở |
| Breakpoint dừng ở file `node_modules` | Chui vào thư viện bằng `F11` | `Shift+F11` để thoát, dùng `F10` |
| Giá trị trong VARIABLES là `undefined` ở dòng chưa chạy | Debugger dừng **trước** khi dòng đó chạy | `F10` một bước rồi xem lại |

## Checklist: tôi đã làm được

- [ ] Gọi một API bằng `fetch`, kiểm tra `status`, đọc JSON.
- [ ] Đặt timeout và phân loại kết quả thành created / rejected / unavailable.
- [ ] Viết retry theo bậc và test nó mà không chờ thật.
- [ ] Giải thích bốn trạng thái của lệnh nạp và các chuyển tiếp.
- [ ] Viết endpoint trả `202` rồi gửi nền, lỗi nền không làm sập.
- [ ] Đặt breakpoint, bước `F10` / `F11`, xem biến và tìm ra một lỗi bằng debugger.
- [ ] Ít nhất 7/10 bài tập xanh (ghi số bài xanh: ___ / 10).

## Câu hỏi còn mở

- Repo hiện **không có** circuit breaker (ngắt mạch khi payment lỗi liên tục); chỉ có timeout và thử lại theo bậc. Hôm nay bạn đã làm đủ hai cơ chế có thật.
- Thao tác debugger trong giao diện VS Code (Windows) **[CHƯA CHẠY]**; báo lại nếu khác với mô tả.
- Ghi những chỗ chưa hiểu để hỏi trước khi vào Ngày 7.
