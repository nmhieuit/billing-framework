# Ngày 4: HTTP API đầu tiên với Fastify

> Thời lượng: 4 giờ. Hôm nay bạn dựng một HTTP API nhỏ bằng **Fastify**, thư viện web mà wallet và payment đang dùng. Mọi thứ vẫn là ví dụ nhỏ tự dựng, dữ liệu để trong bộ nhớ.

## Mục tiêu

- Chạy một server HTTP, gọi nó bằng `curl` và đọc được mã trạng thái, header, JSON trả về.
- Viết route `GET` và `POST`, đọc tham số trên đường dẫn, header, và body JSON.
- Trả đúng mã trạng thái: `200`, `201`, `400`, `401`, `404`; kiểm tra đầu vào.
- Test API **không cần mở cổng** bằng `app.inject(...)`.
- Viết một hook ghi log mỗi request.
- Làm đúng ít nhất 7/9 bài tập.

## Chuẩn bị (5 phút)

- Đã xong Ngày 3.
- Tạo thư mục gõ bài: `mkdir hoc\day4`. Vì hôm nay có cả `import Fastify from 'fastify'`, hãy chạy lệnh từ thư mục `node-training` (nơi có `node_modules`).
- `pnpm test day4` phải **đỏ**.

Kiến thức cần có từ trước: hàm `async`, `interface`, `export` / `import`, test bằng `pnpm test`. Công cụ mới duy nhất ngoài Fastify là `Map` (kho khóa → giá trị), giải thích ở khối 2.

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Server đầu tiên: `GET /health` + Bài 1 | 30 phút |
| 2 | `POST`, body JSON, mã `201` + Bài 3 | 45 phút |
| 3 | Tham số đường dẫn, `404`, `400` + Bài 2, 4, 8 | 50 phút |
| 4 | Header và test bằng `inject` + Bài 5 | 35 phút |
| 5 | Hook ghi log + Bài 7 | 25 phút |
| 6 | Bài tổng hợp: nạp tiền + Bài 6, 9 | 40 phút |
| 7 | Kiểm tra cuối ngày | 15 phút |

---

## Khối 1: Server đầu tiên (20 phút + Bài 1)

Ba khái niệm mới: **route** (đường dẫn + phương thức HTTP), **handler** (hàm xử lý), **`listen`** (mở cổng).

Một API HTTP là chương trình chờ người khác gửi yêu cầu (request) dạng "**phương thức** + **đường dẫn**" (ví dụ `GET /health`) và trả lời (response) gồm **mã trạng thái** (status) và nội dung (thường là JSON).

Gõ hai file. Tách làm hai để hôm nay còn test được mà không cần mở cổng thật. `hoc/day4/a-app.ts`:

```ts
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  app.get('/health', async () => {
    return { status: 'ok' };
  });

  return app;
}
```

`hoc/day4/a-server.ts`:

```ts
import { buildApp } from './a-app.js';

const app = buildApp();
await app.listen({ port: 3000 });
console.log('Server đang chạy ở http://localhost:3000');
```

| File, dòng | Ý nghĩa |
| ---------- | ------- |
| `a-app.ts` 1 | Nhập `Fastify` (thư viện web) |
| `a-app.ts` 3 | Hàm `buildApp` dựng và trả về ứng dụng. Tách ra để test và chạy thật dùng chung một ứng dụng |
| `a-app.ts` 4 | `Fastify()` tạo ứng dụng trống |
| `a-app.ts` 6-8 | `app.get('/health', handler)`: khi có `GET /health` thì chạy handler. Trả về đối tượng nào, Fastify gửi dưới dạng JSON |
| `a-server.ts` 4 | `app.listen({ port: 3000 })` mở cổng 3000 và bắt đầu nhận request. Dòng 4 có `await` ở cấp ngoài cùng, được phép vì file là module |

Chạy server (cửa sổ terminal thứ nhất; terminal sẽ "treo" vì server đang chạy):

```bash
pnpm tsx hoc/day4/a-server.ts
```

```text
Server đang chạy ở http://localhost:3000
```

Mở **terminal thứ hai** (cùng thư mục) và gọi thử. Trên Windows dùng **`curl.exe`** (không gõ `curl` vì trong PowerShell nó là bí danh của lệnh khác):

```bash
curl.exe -i http://localhost:3000/health
```

```text
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
content-length: 15
Date: ...GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"status":"ok"}
```

Cách đọc: dòng đầu có **mã trạng thái** `200 OK`; các dòng tiếp theo là **header**; sau dòng trống là **body** (nội dung). Cờ `-i` của curl để hiện header. Thử một đường dẫn không có:

```bash
curl.exe -i http://localhost:3000/nope
```

```text
HTTP/1.1 404 Not Found
content-type: application/json; charset=utf-8
content-length: 76
Date: ...GMT
Connection: keep-alive
Keep-Alive: timeout=72

{"message":"Route GET:/nope not found","error":"Not Found","statusCode":404}
```

Dừng server bằng `Ctrl+C` ở terminal thứ nhất.

### Bài 1: `GET /health` (Cơ bản, 10 phút)

`day4/ex01-health.ts`. Bài này test bằng `inject`, nên **không cần** chạy server. Chạy `pnpm test day4/ex01`.

---

## Khối 2: `POST`, body JSON, mã `201` (20 phút + Bài 3)

Ba khái niệm mới: **body JSON** (dữ liệu client gửi lên), **`reply.code(...)`** (đặt mã trạng thái), **`Map`** (kho khóa → giá trị trong bộ nhớ).

`GET` để đọc, `POST` để tạo mới. Dữ liệu cần tạo nằm trong **body** của request. Gõ `hoc/day4/b-wallets.ts`:

```ts
import Fastify from 'fastify';

interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp() {
  const app = Fastify();
  const wallets = new Map<string, Wallet>();

  app.post('/wallets', async (request, reply) => {
    const body = request.body as { owner?: unknown } | null;
    if (typeof body?.owner !== 'string' || body.owner === '') {
      return reply.code(400).send({ error: 'owner is required' });
    }
    const wallet: Wallet = { id: `w${wallets.size + 1}`, owner: body.owner, balance: 0 };
    wallets.set(wallet.id, wallet);
    return reply.code(201).send(wallet);
  });

  app.get('/wallets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wallet = wallets.get(id);
    if (!wallet) {
      return reply.code(404).send({ error: 'wallet not found' });
    }
    return wallet;
  });

  return app;
}
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 11 | `new Map<string, Wallet>()`: kho lưu ví, khóa là chuỗi `id`, giá trị là `Wallet`. `wallets.set(k, v)` ghi, `wallets.get(k)` đọc (không có thì `undefined`), `wallets.size` đếm |
| 13 | `app.post(...)`: route `POST /wallets`. Tham số `request` là yêu cầu, `reply` dùng để trả lời |
| 14 | Lấy body; `as {...}` là cách nói cho TypeScript "tin tôi, body có hình dạng này". Body có thể thiếu nên cho phép `null` |
| 15-17 | **Kiểm tra đầu vào**: không phải chuỗi hoặc rỗng thì trả `400 Bad Request` và dừng (`return`) |
| 18 | Tạo ví với `id` kiểu `w1`, `w2`... |
| 20 | `reply.code(201).send(wallet)`: `201 Created` là mã chuẩn khi tạo thành công |

Chạy `b-server.ts` (xem file mẫu ở `examples/day4/b-server.ts`, giống `a-server.ts` nhưng nhập từ `b-wallets.js`), rồi ở terminal thứ hai. Trên PowerShell, gõ JSON trong dòng lệnh dễ sai vì dấu nháy, nên hãy ghi body vào file rồi bảo curl đọc file đó. Tạo `hoc/day4/body.json` với nội dung `{"owner":"An"}`, và `hoc/day4/empty.json` với nội dung `{}`:

```bash
curl.exe -i -X POST http://localhost:3000/wallets -H "content-type: application/json" -d "@hoc/day4/body.json"
```

```text
HTTP/1.1 201 Created
...
{"id":"w1","owner":"An","balance":0}
```

Gửi body sai (thiếu `owner`):

```bash
curl.exe -i -X POST http://localhost:3000/wallets -H "content-type: application/json" -d "@hoc/day4/empty.json"
```

```text
HTTP/1.1 400 Bad Request
...
{"error":"owner is required"}
```

Hai điều quan trọng:

- Cờ `-H "content-type: application/json"` báo cho server biết body là JSON; thiếu nó, server không đọc được body.
- **Không bao giờ tin dữ liệu từ client**: luôn kiểm tra kiểu và giá trị trước khi dùng.

### Bài 3: tạo ví (Trung bình, 25 phút)

`day4/ex03-create-wallet.ts`. Làm theo mẫu `b-wallets.ts` nhưng **tự gõ**. Chạy `pnpm test day4/ex03`.

---

## Khối 3: Tham số đường dẫn, `404` và `400` (15 phút + Bài 2, 4, 8)

Ba khái niệm mới: **tham số đường dẫn** (`/wallets/:id`), **`404 Not Found`**, **chuẩn hóa lỗi thành JSON**.

Trong `b-wallets.ts` còn một route nữa (dòng 23-30):

| Dòng | Ý nghĩa |
| ---- | ------- |
| 23 | `'/wallets/:id'`: phần `:id` là chỗ trống, khớp bất kỳ giá trị nào, ví dụ `/wallets/w1` |
| 24 | `const { id } = request.params` lấy giá trị đó (destructuring, đã học ở Ngày 2) |
| 25-28 | Không tìm thấy ví thì trả `404` với JSON `{ error: 'wallet not found' }` |

```bash
curl.exe -i http://localhost:3000/wallets/w1
```

```text
HTTP/1.1 200 OK
...
{"id":"w1","owner":"An","balance":0}
```

```bash
curl.exe -i http://localhost:3000/wallets/zzz
```

```text
HTTP/1.1 404 Not Found
...
{"error":"wallet not found"}
```

Bảng mã trạng thái dùng nhiều nhất:

| Mã | Tên | Khi nào dùng |
| -- | --- | ------------ |
| 200 | OK | Đọc / xử lý thành công |
| 201 | Created | Tạo mới thành công |
| 400 | Bad Request | Dữ liệu client gửi sai |
| 401 | Unauthorized | Thiếu thông tin xác định người gọi |
| 404 | Not Found | Không có thứ được hỏi |
| 500 | Internal Server Error | Lỗi của **server** (bug) |

Nhớ: `4xx` = lỗi do **người gọi**; `5xx` = lỗi do **server**.

### Bài 2: chào theo tên (Cơ bản, 10 phút)

`day4/ex02-hello.ts`. Chạy `pnpm test day4/ex02`.

### Bài 4: đọc ví (Trung bình, 15 phút)

`day4/ex04-get-wallet.ts`. Route `POST /wallets` đã có sẵn, bạn thêm `GET /wallets/:id`. Chạy `pnpm test day4/ex04`.

### Bài 8: ví có mà không tìm ra (Sửa lỗi, 10 phút)

`day4/ex08-bug-param.ts`. Chạy `pnpm test day4/ex08`. Gợi ý: thêm `console.log(request.params)` vào handler rồi chạy lại để xem bên trong thực sự có gì. Đối chiếu tên trong đường dẫn với tên bạn đọc ra.

---

## Khối 4: Header và test bằng `inject` (20 phút + Bài 5)

Ba khái niệm mới: **header của request**, **`app.inject(...)`**, **`statusCode` và `.json()`** của kết quả.

**Header** là thông tin kèm theo request ngoài body: ví dụ `x-customer-id: c1`. Dự án thật dùng header để biết ai đang gọi (khách nào, tenant nào). Trong Fastify: `request.headers['x-customer-id']`; tên header luôn được hạ xuống chữ thường.

Bạn đã dùng `inject` từ đầu ngày qua các test. Giờ gõ file test của chính bạn `hoc/day4/c-wallets.test.ts`:

```ts
import { expect, test } from 'vitest';
import { buildApp } from './b-wallets.js';

test('tạo ví rồi đọc lại', async () => {
  const app = buildApp();

  const created = await app.inject({ method: 'POST', url: '/wallets', payload: { owner: 'An' } });
  expect(created.statusCode).toBe(201);
  expect(created.json()).toEqual({ id: 'w1', owner: 'An', balance: 0 });

  const found = await app.inject({ method: 'GET', url: '/wallets/w1' });
  expect(found.statusCode).toBe(200);
  expect(found.json().owner).toBe('An');
});

test('ví không tồn tại -> 404', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'GET', url: '/wallets/zzz' });
  expect(res.statusCode).toBe(404);
});

test('thiếu owner -> 400', async () => {
  const app = buildApp();
  const res = await app.inject({ method: 'POST', url: '/wallets', payload: {} });
  expect(res.statusCode).toBe(400);
});
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 5 | Mỗi test dựng ứng dụng **mới**: dữ liệu trong `Map` của test này không lẫn sang test khác |
| 7 | `app.inject({...})` giả lập một request đi vào ứng dụng **trong bộ nhớ**, không mở cổng, không cần curl. Rất nhanh |
| 8-9 | `created.statusCode` là mã trạng thái; `created.json()` đọc body thành đối tượng |
| 11 | `GET` ví vừa tạo; nhờ dùng chung `app` nên ví vẫn còn |
| 16-20, 22-26 | Test đường lỗi: `404`, `400` |

Chạy: `pnpm test hoc/day4`.

Thói quen tốt: với **mỗi endpoint**, viết ít nhất một test thành công và một test cho mỗi loại lỗi.

### Bài 5: đọc header (Trung bình, 15 phút)

`day4/ex05-header.ts`: `GET /me` trả khách đang gọi, hoặc `401` nếu thiếu header. Chạy `pnpm test day4/ex05`.

---

## Khối 5: Hook ghi log (10 phút + Bài 7)

Ba khái niệm mới: **hook** (đoạn code chạy ở một thời điểm cố định của vòng đời request), **`onResponse`**, **log để quan sát**.

Muốn ghi log cho **mọi** request mà không sửa từng route, dùng hook. Gõ `hoc/day4/d-hook.ts`:

```ts
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  app.addHook('onResponse', async (request, reply) => {
    console.log(`${request.method} ${request.url} -> ${reply.statusCode}`);
  });

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 6-8 | `addHook('onResponse', ...)`: chạy **sau khi** response đã gửi. Có sẵn `request` và `reply` để đọc phương thức, URL, mã trạng thái |
| 10 | Route bình thường |

Chạy server mẫu (`d-server.ts` giống `a-server.ts` nhưng nhập `d-hook.js`), gọi `curl.exe http://localhost:3000/health` và nhìn terminal của server:

```text
Server đang chạy ở http://localhost:3000
GET /health -> 200
```

Trong hệ thống thật, dòng log như vậy là thứ bạn tìm đầu tiên khi điều tra sự cố ("request này có đến server không? trả mã gì?").

### Bài 7: log request (Nâng cao, 15 phút)

`day4/ex07-request-log.ts`. Chạy `pnpm test day4/ex07`.

---

## Khối 6: Tổng hợp (40 phút)

### Bài 6: nạp tiền vào ví (Nâng cao, 30 phút)

`day4/ex06-deposit.ts`: `POST /wallets/:id/deposit`. Bài này gộp tham số đường dẫn, body, kiểm tra đầu vào và 3 mã trạng thái. **Thứ tự kiểm tra có ý nghĩa**: tìm ví (`404`) trước, kiểm tra `amount` (`400`) sau. Chạy `pnpm test day4/ex06`.

### Bài 9: thêm route sau khi app đã sẵn sàng (Sửa lỗi, 10 phút)

`day4/ex09-bug-late-route.ts`. Test ném lỗi ngay khi dựng ứng dụng. Đọc thông báo lỗi (có mã `FST_ERR_...`), tìm dòng gây ra, và đổi thứ tự các dòng. Chạy `pnpm test day4/ex09`.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-health.ts` | Cơ bản | 10' | `pnpm test day4/ex01` | xanh |
| 2 | `ex02-hello.ts` | Cơ bản | 10' | `pnpm test day4/ex02` | xanh |
| 3 | `ex03-create-wallet.ts` | Trung bình | 25' | `pnpm test day4/ex03` | xanh |
| 4 | `ex04-get-wallet.ts` | Trung bình | 15' | `pnpm test day4/ex04` | xanh |
| 5 | `ex05-header.ts` | Trung bình | 15' | `pnpm test day4/ex05` | xanh |
| 6 | `ex06-deposit.ts` | Nâng cao | 30' | `pnpm test day4/ex06` | xanh |
| 7 | `ex07-request-log.ts` | Nâng cao | 15' | `pnpm test day4/ex07` | xanh |
| 8 | `ex08-bug-param.ts` | Sửa lỗi | 10' | `pnpm test day4/ex08` | xanh |
| 9 | `ex09-bug-late-route.ts` | Sửa lỗi | 10' | `pnpm test day4/ex09` | xanh |

Chạy cả ngày: `pnpm test day4`. Lời giải: `node-training/solutions/day4/`.

## Gợi ý (mở từng mức)

<details><summary>Bài 1: health</summary>

1. Dùng `app.get('/health', ...)`.
2. Handler là hàm `async`.
3. `app.get('/health', async () => { return { status: 'ok' }; });`

</details>

<details><summary>Bài 2: hello</summary>

1. Đường dẫn có tham số: `'/hello/:name'`.
2. Handler nhận `request`; đọc `request.params`.
3. `const { name } = request.params as { name: string }; return { message: \`Xin chào, ${name}!\` };`

</details>

<details><summary>Bài 3: create wallet</summary>

1. Dùng `app.post('/wallets', async (request, reply) => { ... })`.
2. Kiểm tra `owner` sai thì `return reply.code(400).send({ error: 'owner is required' });`.
3. Thành công: tạo ví với `id: \`w${wallets.size + 1}\``, `wallets.set(...)`, rồi `return reply.code(201).send(wallet);`.

</details>

<details><summary>Bài 4: get wallet</summary>

1. Route `app.get('/wallets/:id', ...)`.
2. Lấy `id` từ `request.params`, tra `wallets.get(id)`.
3. Không có thì `return reply.code(404).send({ error: 'wallet not found' });`, có thì `return wallet;`.

</details>

<details><summary>Bài 5: header</summary>

1. `request.headers['x-customer-id']` có thể là chuỗi hoặc `undefined`.
2. Thiếu (hoặc rỗng) thì `reply.code(401).send({ error: ... })`.
3. Có thì `return { customerId };`.

</details>

<details><summary>Bài 6: deposit</summary>

1. Route `app.post('/wallets/:id/deposit', ...)`; lấy ví từ `wallets` (tham số truyền vào `buildApp`).
2. Thứ tự: ví không có → `404`; `amount` không hợp lệ → `400`; thành công → cộng tiền.
3. `amount` hợp lệ khi `typeof amount === 'number' && Number.isInteger(amount) && amount > 0`. Thành công trả `{ id: wallet.id, balance: wallet.balance }`.

</details>

<details><summary>Bài 7: request log</summary>

1. Dùng `app.addHook('onResponse', ...)` như `d-hook.ts`.
2. Không `console.log` mà gọi hàm `log` nhận vào.
3. `log(\`${request.method} ${request.url} ${reply.statusCode}\`);`

</details>

<details><summary>Bài 8: bug param</summary>

1. Thêm `console.log(request.params)` để xem.
2. Đường dẫn khai báo `:walletId`; code đang đọc tên khác.
3. Đọc `const { walletId } = request.params as { walletId: string };` rồi dùng `walletId`.

</details>

<details><summary>Bài 9: bug late route</summary>

1. Đọc mã lỗi trong thông báo: nó nói điều gì về thời điểm thêm route?
2. `await app.ready()` nghĩa là "mọi thứ đã nạp xong, đóng cửa".
3. Chuyển `await app.ready();` xuống dưới mọi lệnh `app.get(...)`.

</details>

## Kiểm tra cuối ngày (15 phút)

1. `GET` và `POST` khác nhau ở điểm nào? Khi nào dùng `201`?
2. `4xx` và `5xx` khác nhau về ý nghĩa như thế nào?
3. Vì sao cần kiểm tra body trước khi dùng?
4. `app.inject` khác `curl` ở chỗ nào, vì sao hữu ích?
5. Hook `onResponse` dùng để làm gì?
6. Vì sao tách `buildApp()` khỏi file gọi `listen`?

<details><summary>Đáp án</summary>

1. `GET` để đọc, thường không có body; `POST` để tạo / gửi dữ liệu, có body. `201` khi tạo mới thành công.
2. `4xx`: lỗi do người gọi (dữ liệu sai, thiếu quyền, không tìm thấy). `5xx`: lỗi do server.
3. Dữ liệu từ client không đáng tin; thiếu hoặc sai kiểu có thể làm hỏng logic hoặc gây lỗi 500.
4. `inject` đưa request vào ứng dụng trong bộ nhớ, không qua mạng, nên nhanh và không cần cổng; tiện cho test tự động.
5. Chạy đoạn code sau khi response đã gửi, dùng để ghi log mọi request mà không sửa từng route.
6. Để test và chạy thật dùng chung ứng dụng; test không phải mở cổng.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| `EADDRINUSE: address already in use :::3000` | Server cũ vẫn đang chạy | `Ctrl+C` ở terminal đó, hoặc tắt tiến trình `node` cũ |
| `curl: Could not connect` | Server chưa chạy, hoặc sai cổng | Xem terminal server có dòng "đang chạy" không |
| Server nhận body `undefined` | Thiếu header `content-type: application/json` | Thêm `-H "content-type: application/json"` |
| PowerShell: `Invoke-WebRequest` thay cho curl | Gõ `curl` thay vì `curl.exe` | Luôn gõ `curl.exe` |
| JSON trong dòng lệnh bị lỗi dấu nháy | PowerShell xử lý nháy kép khác bash | Ghi body vào file, dùng `-d "@file.json"` |
| Handler chạy tiếp sau khi đã trả lời | Quên `return` trước `reply.code(...).send(...)` | Luôn `return reply...send(...)` |
| `FST_ERR_...` lúc khởi động | Thêm route sau `ready()`/`listen()` | Đăng ký mọi route trước |

## Checklist: tôi đã làm được

- [ ] Chạy server Fastify và gọi `GET /health` bằng `curl.exe`.
- [ ] Đọc được mã trạng thái, header và body trong kết quả `curl -i`.
- [ ] Viết được route `POST` đọc body JSON, kiểm tra đầu vào, trả `201` / `400`.
- [ ] Viết được route có `:id`, trả `404` khi không có.
- [ ] Viết test endpoint bằng `app.inject`.
- [ ] Ít nhất 7/9 bài tập xanh (ghi số bài xanh: ___ / 9).

## Câu hỏi còn mở

- Các lệnh `curl.exe` và `-d "@file.json"` đã chạy thật trên Linux; trên Windows PowerShell **[CHƯA CHẠY]**. Nếu `-d "@..."` hoạt động khác, hãy báo lại.
- Dự án thật dùng NestJS (một lớp bao Fastify). Ngày 7 sẽ cho bạn thấy `@Get('wallet')` tương ứng với `app.get(...)` như thế nào.
