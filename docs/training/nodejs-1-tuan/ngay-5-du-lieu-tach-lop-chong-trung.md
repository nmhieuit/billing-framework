# Ngày 5: Tiền, tách lớp và chống xử lý trùng

> Thời lượng: 4 giờ. Hôm nay bạn học ba thứ mà mọi hệ thống tiền đều cần: **lưu tiền bằng số nguyên**, **tách code thành các lớp** (HTTP / nghiệp vụ / lưu trữ), và **chống xử lý trùng** bằng `Idempotency-Key`. Vẫn là ví dụ nhỏ tự dựng, dữ liệu trong bộ nhớ.

## Mục tiêu

- Giải thích vì sao tiền được lưu bằng số nguyên đơn vị nhỏ nhất (không dùng số thập phân).
- Viết một repository trong bộ nhớ, một service dùng nó, và một lớp HTTP mỏng bên trên; nói được mỗi lớp chịu trách nhiệm gì.
- Dùng `Idempotency-Key` để một yêu cầu gửi lại nhiều lần chỉ có tác dụng **một lần**; xử lý ba trường hợp: lặp lại hệt, khác nội dung, gửi đồng thời.
- Làm đúng ít nhất 7/10 bài (bài 8 tùy chọn).

## Chuẩn bị (5 phút)

- Đã xong Ngày 4. Tạo thư mục gõ bài: `mkdir hoc\day5`.
- `pnpm test day5` phải **đỏ**.
- Thư mục `day5/support/` chứa vài file **đã viết sẵn** (lỗi, repository, service) dùng cho bài 3 và 4. Không sửa chúng.

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Tiền là số nguyên + Bài 1 | 25 phút |
| 2 | Repository + Bài 2 | 25 phút |
| 3 | Service, lỗi tự định nghĩa + Bài 3 | 35 phút |
| 4 | Lớp HTTP mỏng + Bài 4 | 30 phút |
| 5 | `Idempotency-Key` + Bài 5, 6 | 55 phút |
| 6 | Hai request đồng thời + Bài 7 | 20 phút |
| 7 | Bài sửa lỗi 9, 10 | 15 phút |
| 8 | Kiểm tra cuối ngày | 15 phút |

Bài 8 (sổ cái ghi sổ kép) là bài tùy chọn, làm khi còn thời gian.

---

## Khối 1: Tiền là số nguyên (10 phút + Bài 1)

Ba khái niệm mới: **sai số của số thập phân**, **đơn vị nhỏ nhất** (cent), **làm tròn**.

Gõ `hoc/day5/a-money.js`:

```js
console.log(0.1 + 0.2);
console.log(0.1 + 0.2 === 0.3);

const priceInCents = 10 + 20;
console.log(priceInCents, priceInCents === 30);
console.log(Math.round(12.34 * 100));
```

```text
$ node hoc/day5/a-money.js
0.30000000000000004
false
30 true
1234
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1-2 | `0.1 + 0.2` **không** bằng `0.3` mà là `0.30000000000000004`. Máy tính lưu số thập phân dưới dạng nhị phân gần đúng. Với tiền, sai lệch này là thảm họa |
| 4-5 | Cộng bằng **số nguyên** (10 cent + 20 cent = 30 cent) thì luôn chính xác |
| 6 | `12.34 * 100` ra `1234` sau khi làm tròn (`Math.round`); không có làm tròn thì có thể ra `1233.9999999999998` |

Quy tắc của hệ thống tiền, cũng là quy tắc của dự án thật: **lưu và tính tiền bằng số nguyên của đơn vị nhỏ nhất** (ví dụ 12,34 USD = `1234` cent; với VND, đơn vị nhỏ nhất là 1 đồng). Chỉ đổi sang dạng hiển thị ở khâu cuối cùng.

### Bài 1: đổi qua lại giữa chuỗi và cent (Cơ bản, 15 phút)

`day5/ex01-cents.ts`. Đề bài dặn **không** dùng `Number(text) * 100`, vì chính phép nhân đó gây sai số. Hãy tách phần nguyên và phần lẻ bằng chuỗi. Chạy `pnpm test day5/ex01`.

---

## Khối 2: Repository (10 phút + Bài 2)

Ba khái niệm mới: **repository** (lớp lo việc lưu và đọc dữ liệu), **bản sao bằng `{ ...obj }`**, **`Map` làm kho**.

Nếu mỗi nơi trong code tự đọc / ghi dữ liệu theo cách riêng, khi đổi cách lưu (bộ nhớ → SQL Server) bạn phải sửa khắp nơi. Cách giải quyết: gom việc lưu vào **một lớp**, chỉ lộ ra vài hàm như `save`, `findById`. Gõ `hoc/day5/b-repository.ts`:

```ts
export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export class WalletRepository {
  #wallets = new Map<string, Wallet>();

  save(wallet: Wallet): void {
    this.#wallets.set(wallet.id, { ...wallet });
  }

  findById(id: string): Wallet | undefined {
    const found = this.#wallets.get(id);
    return found ? { ...found } : undefined;
  }
}
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 8 | Kho là `Map` nằm trong trường riêng `#wallets` (Ngày 2); bên ngoài không đụng thẳng vào được |
| 10-12 | `save` lưu **bản sao** `{ ...wallet }`. Dấu `...` ("spread") chép từng thuộc tính sang một đối tượng mới |
| 14-17 | `findById` cũng trả **bản sao**, hoặc `undefined` nếu không có |

Vì sao sao chép? Gõ `hoc/day5/b-main.ts` để thấy:

```ts
import { WalletRepository } from './b-repository.js';

const repo = new WalletRepository();
repo.save({ id: 'w1', owner: 'An', balance: 100 });

const copy = repo.findById('w1');
if (copy) {
  copy.balance = 999;
}
console.log('trong kho:', repo.findById('w1')?.balance);
console.log('bản sao  :', copy?.balance);
```

```text
$ pnpm tsx hoc/day5/b-main.ts
trong kho: 100
bản sao  : 999
```

Sửa `copy.balance = 999` **không** làm đổi dữ liệu trong kho. Muốn đổi thật thì phải gọi `save`. Điều này giống cách database hoạt động: bạn đọc ra một bản, sửa trên bản đó, rồi ghi lại.

### Bài 2: viết repository (Cơ bản, 15 phút)

`day5/ex02-repository.ts`. Chạy `pnpm test day5/ex02`. Hai test cuối kiểm tra việc sao chép ở cả hai chiều (`save` và `findById`).

---

## Khối 3: Service và lỗi tự định nghĩa (15 phút + Bài 3)

Ba khái niệm mới: **service** (lớp chứa quy tắc nghiệp vụ), **lớp lỗi riêng** (`class X extends Error`), **tiêm phụ thuộc qua constructor**.

Quy tắc nghiệp vụ ("rút không được quá số dư", "ví phải tồn tại") nên nằm trong một lớp riêng: **service**. Service không biết HTTP, không biết dữ liệu lưu ở đâu; nó chỉ nhận một repository và làm việc với repository đó. Gõ `hoc/day5/c-service.ts`:

```ts
import { WalletRepository } from './b-repository.js';

export class WalletNotFoundError extends Error {
  constructor(id: string) {
    super(`wallet not found: ${id}`);
  }
}

export class WalletService {
  constructor(private readonly repo: WalletRepository) {}

  deposit(id: string, amount: number): number {
    const wallet = this.repo.findById(id);
    if (!wallet) {
      throw new WalletNotFoundError(id);
    }
    wallet.balance += amount;
    this.repo.save(wallet);
    return wallet.balance;
  }
}
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3-7 | `class WalletNotFoundError extends Error`: một **loại lỗi riêng**. Nơi bắt lỗi có thể hỏi `error instanceof WalletNotFoundError` để biết đúng loại lỗi nào xảy ra |
| 10 | `constructor(private readonly repo: WalletRepository)`: service **nhận** repository từ bên ngoài thay vì tự tạo. Đây là "tiêm phụ thuộc". Lợi ích: test có thể đưa vào một repository giả, sau này có thể đưa vào repository SQL mà không sửa service |
| 14-16 | Không có ví thì ném lỗi riêng |
| 17-19 | Đọc ví (bản sao), sửa số dư, `save` lại, trả số dư mới |

Gõ `hoc/day5/c-main.ts` để chạy thử:

```ts
import { WalletRepository } from './b-repository.js';
import { WalletService } from './c-service.js';

const repo = new WalletRepository();
repo.save({ id: 'w1', owner: 'An', balance: 100 });
const service = new WalletService(repo);

console.log(service.deposit('w1', 50));
console.log(service.deposit('w1', 25));
try {
  service.deposit('zz', 1);
} catch (error) {
  console.log((error as Error).message);
}
```

```text
$ pnpm tsx hoc/day5/c-main.ts
150
175
wallet not found: zz
```

### Bài 3: dịch vụ rút tiền (Trung bình, 20 phút)

`day5/ex03-service.ts`. Bạn tự viết lớp `InsufficientFundsError` và hàm `withdraw`. Thứ tự kiểm tra: số tiền hợp lệ → ví tồn tại → đủ tiền. Test dùng repository viết sẵn ở `day5/support/`. Chạy `pnpm test day5/ex03`.

---

## Khối 4: Lớp HTTP mỏng (10 phút + Bài 4)

Ba khái niệm mới: **ba lớp** (HTTP → service → repository), **ánh xạ lỗi sang mã HTTP**, **lớp mỏng**.

Gộp lại, mỗi yêu cầu đi qua ba lớp, mỗi lớp một việc:

| Lớp | Việc của nó | Không được làm |
| --- | ----------- | -------------- |
| HTTP (route) | Đọc request, gọi service, **đổi lỗi thành mã trạng thái**, trả JSON | Không chứa quy tắc nghiệp vụ |
| Service | Quy tắc nghiệp vụ, ném lỗi riêng | Không biết HTTP, không biết lưu ở đâu |
| Repository | Lưu và đọc dữ liệu | Không chứa quy tắc nghiệp vụ |

Ví dụ ánh xạ: `WalletNotFoundError` → `404`; `InvalidAmountError` → `400`. Mẫu code trong handler:

```ts
try {
  return service.get(id);
} catch (error) {
  if (error instanceof WalletNotFoundError) {
    return reply.code(404).send({ error: error.message });
  }
  throw error; // lỗi lạ: không tự đoán, ném tiếp để thành 500 và còn dấu vết
}
```

### Bài 4: lớp HTTP trên service (Trung bình, 20 phút)

`day5/ex04-http-layer.ts`. Service đã viết sẵn ở `day5/support/wallet-service.ts` (bạn có thể mở ra đọc). Chỉ viết hai route. Chạy `pnpm test day5/ex04`. Khi xong, bạn đã dựng một ứng dụng ba lớp hoàn chỉnh.

---

## Khối 5: `Idempotency-Key` (15 phút + Bài 5, 6)

Ba khái niệm mới: **idempotent** (làm nhiều lần cũng như làm một lần), **Idempotency-Key**, **fingerprint** (dấu vân tay của nội dung yêu cầu).

Tình huống thật: client gửi `POST /topups` nạp 100.000 đồng, mạng chập chờn nên **không nhận được phản hồi**. Client không biết server đã nhận hay chưa, nên gửi lại. Nếu server xử lý lần hai như yêu cầu mới, khách bị **nạp hai lần**.

Giải pháp: client gửi kèm header `Idempotency-Key` (một chuỗi duy nhất cho mỗi *ý định* nạp tiền). Server nhớ: "khóa này đã xử lý, kết quả là X". Gặp lại khóa đó thì trả **lại đúng kết quả X**, không làm lại. Gõ `hoc/day5/d-app.ts`:

```ts
import Fastify from 'fastify';

interface Saved {
  fingerprint: string;
  status: number;
  body: unknown;
}

export function buildApp() {
  const app = Fastify();
  const saved = new Map<string, Saved>();
  let balance = 0;

  app.post('/topups', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string') {
      return reply.code(400).send({ error: 'idempotency-key header is required' });
    }
    const body = request.body as { amount: number };
    const fingerprint = JSON.stringify(body);

    const previous = saved.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
      }
      return reply.header('idempotent-replayed', 'true').code(previous.status).send(previous.body);
    }

    balance += body.amount;
    const response = { balance };
    saved.set(key, { fingerprint, status: 201, body: response });
    return reply.code(201).send(response);
  });

  return app;
}
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 11 | `saved` nhớ kết quả theo khóa |
| 15-18 | Thiếu header thì `400` |
| 20 | `fingerprint = JSON.stringify(body)`: chuỗi mô tả nội dung yêu cầu |
| 22-28 | **Khóa đã có**: nếu nội dung khác → `422` (dùng lại khóa cho việc khác là lỗi của client); nếu nội dung giống → trả lại kết quả đã lưu kèm header `idempotent-replayed: true`, và **không cộng tiền nữa** |
| 30-33 | **Khóa mới**: làm việc thật (cộng tiền), lưu kết quả, trả `201` |

Chạy thử bằng server (tạo `hoc/day5/d-server.ts` giống `a-server.ts` ở Ngày 4 nhưng nhập `d-app.js`; tạo `body100.json` chứa `{"amount":100}`, `body999.json` chứa `{"amount":999}`):

```bash
curl.exe -i -X POST http://localhost:3000/topups -H "content-type: application/json" -H "idempotency-key: k1" -d "@hoc/day5/body100.json"
```

```text
HTTP/1.1 201 Created
...
{"balance":100}
```

Gửi **lại y hệt**:

```text
HTTP/1.1 201 Created
idempotent-replayed: true
...
{"balance":100}
```

Số dư vẫn 100, không thành 200; header `idempotent-replayed: true` cho biết đây là bản phát lại. Gửi cùng khóa nhưng với `body999.json`:

```text
{"error":"IDEMPOTENCY_KEY_REUSED"}
```

Gõ test `hoc/day5/e-topup.test.ts` cho cả hai trường hợp:

```ts
import { expect, test } from 'vitest';
import { buildApp } from './d-app.js';

const send = (app: ReturnType<typeof buildApp>, key: string, amount: number) =>
  app.inject({ method: 'POST', url: '/topups', headers: { 'idempotency-key': key }, payload: { amount } });

test('gửi lại cùng key và cùng nội dung: không cộng tiền hai lần', async () => {
  const app = buildApp();
  const first = await send(app, 'k1', 100);
  const second = await send(app, 'k1', 100);
  expect(first.statusCode).toBe(201);
  expect(second.statusCode).toBe(201);
  expect(second.json()).toEqual({ balance: 100 });
  expect(second.headers['idempotent-replayed']).toBe('true');
});

test('cùng key nhưng khác nội dung: 422', async () => {
  const app = buildApp();
  await send(app, 'k1', 100);
  expect((await send(app, 'k1', 999)).statusCode).toBe(422);
});
```

### Bài 5: bộ nhớ idempotency (Trung bình, 15 phút)

`day5/ex05-idempotency-store.ts`: tách riêng "cái nhớ" ra khỏi HTTP thành một hàm `run(key, fingerprint, work)`. Chạy `pnpm test day5/ex05`.

### Bài 6: endpoint nạp tiền hoàn chỉnh (Nâng cao, 25 phút)

`day5/ex06-topup-endpoint.ts`: viết lại `POST /topups` theo `d-app.ts` nhưng thêm kiểm tra `amount`, `topupId` tăng dần, và phát lại **y nguyên** cả mã trạng thái lẫn body. Chạy `pnpm test day5/ex06`.

---

## Khối 6: Hai request đến cùng lúc (10 phút + Bài 7)

Ba khái niệm mới: **race condition** (hai việc chạy đan xen gây kết quả sai), **lưu Promise thay vì kết quả**, **hủy khóa khi thất bại**.

`d-app.ts` đúng khi request đến lần lượt. Nhưng điều gì xảy ra nếu hai request cùng khóa đến **gần như cùng lúc**, khi việc thật còn đang chạy (`await`)? Gõ `hoc/day5/f-race.ts`:

```ts
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const saved = new Map<string, string>();
let charges = 0;

async function topupOnce(key: string): Promise<string> {
  const previous = saved.get(key);
  if (previous) {
    return previous;
  }
  charges += 1;
  const chargeNo = charges;
  await sleep(50);
  const result = `charge-${chargeNo}`;
  saved.set(key, result);
  return result;
}

const results = await Promise.all([topupOnce('k1'), topupOnce('k1')]);
console.log(results, 'số lần trừ tiền:', charges);
```

```text
$ pnpm tsx hoc/day5/f-race.ts
[ 'charge-1', 'charge-2' ] số lần trừ tiền: 2
```

Cả hai lời gọi đều thấy `saved` còn trống (dòng 7) trước khi cái nào kịp lưu kết quả (dòng 15), nên **cả hai cùng trừ tiền**: số lần trừ tiền là 2. Đây là *race condition*.

Cách sửa: lưu ngay **chính Promise** vào `Map` ở thời điểm bắt đầu, trước khi `await`. Lời gọi thứ hai thấy Promise đang chạy và chờ cùng Promise đó thay vì chạy lại.

### Bài 7: gộp các lời gọi đồng thời (Nâng cao, 20 phút)

`day5/ex07-concurrent.ts`. Hai yêu cầu của bài: gọi đồng thời cùng khóa thì `work` chỉ chạy **một lần**; nếu `work` thất bại thì quên khóa để lần sau được thử lại. Chạy `pnpm test day5/ex07`.

> Trong dự án thật, cơ chế tương ứng nằm ở database: khóa idempotency là khóa chính của một bảng; request đến sau vấp lỗi trùng khóa, giao dịch hoàn tác và thử lại một lần, lần này sẽ thấy bản ghi của request đến trước. Bạn sẽ gặp ở Ngày 7.

### Bài 8 (tùy chọn): sổ cái ghi sổ kép (Nâng cao, 25 phút)

`day5/ex08-ledger.ts`: mỗi lần nạp tiền ghi **hai dòng** (tiền vào ví +100, nguồn tiền −100), tổng luôn bằng 0; mỗi lần ghi có mã `reference` duy nhất như một ràng buộc `UNIQUE`. Đây là mô hình của sổ cái trong dự án. Chạy `pnpm test day5/ex08`.

---

## Khối 7: Bài sửa lỗi (15 phút)

### Bài 9: ví có mà không tìm ra (Sửa lỗi, 5 phút)

`day5/ex09-bug-key-type.ts`. Chạy `pnpm test day5/ex09`. Dữ liệu từ URL luôn là **chuỗi**; khóa trong `Map` đang là **số**. `'1'` và `1` là hai khóa khác nhau.

### Bài 10: yêu cầu hỏng làm kẹt khóa (Sửa lỗi, 10 phút)

`day5/ex10-bug-save-too-early.ts`. Chạy `pnpm test day5/ex10`. Hỏi: nên ghi nhớ khóa **trước** hay **sau** khi việc thật thành công? Nếu việc thất bại mà vẫn nhớ khóa, lần thử lại sẽ nhận lại "kết quả" sai. Đây là lỗi thật gặp trong hệ thống thanh toán.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-cents.ts` | Cơ bản | 15' | `pnpm test day5/ex01` | xanh |
| 2 | `ex02-repository.ts` | Cơ bản | 15' | `pnpm test day5/ex02` | xanh |
| 3 | `ex03-service.ts` | Trung bình | 20' | `pnpm test day5/ex03` | xanh |
| 4 | `ex04-http-layer.ts` | Trung bình | 20' | `pnpm test day5/ex04` | xanh |
| 5 | `ex05-idempotency-store.ts` | Trung bình | 15' | `pnpm test day5/ex05` | xanh |
| 6 | `ex06-topup-endpoint.ts` | Nâng cao | 25' | `pnpm test day5/ex06` | xanh |
| 7 | `ex07-concurrent.ts` | Nâng cao | 20' | `pnpm test day5/ex07` | xanh |
| 8 | `ex08-ledger.ts` (tùy chọn) | Nâng cao | 25' | `pnpm test day5/ex08` | xanh |
| 9 | `ex09-bug-key-type.ts` | Sửa lỗi | 5' | `pnpm test day5/ex09` | xanh |
| 10 | `ex10-bug-save-too-early.ts` | Sửa lỗi | 10' | `pnpm test day5/ex10` | xanh |

Chạy cả ngày: `pnpm test day5`. Lời giải: `node-training/solutions/day5/`.

## Gợi ý (mở từng mức)

<details><summary>Bài 1: cents</summary>

1. Kiểm tra đầu vào bằng `/^\d+(\.\d{1,2})?$/.test(text)`; sai thì `throw new Error(\`invalid money: ${text}\`)`.
2. `text.split('.')` cho phần nguyên và phần lẻ (có thể thiếu phần lẻ). Phần lẻ `'1'` phải thành `10`, nên cần "đệm" thêm số 0: `fraction.padEnd(2, '0')`.
3. `toCents`: `Number(whole) * 100 + Number(fraction.padEnd(2, '0'))`. `fromCents`: phần nguyên `Math.floor(cents / 100)`, phần lẻ `String(cents % 100).padStart(2, '0')`.

</details>

<details><summary>Bài 2: repository</summary>

1. Dùng `Map` làm kho, đặt trong trường riêng `#wallets`.
2. `save`: `this.#wallets.set(wallet.id, { ...wallet })`.
3. `findById`: lấy ra, nếu có thì trả `{ ...found }`, nếu không `undefined`. `count`: `this.#wallets.size`.

</details>

<details><summary>Bài 3: service</summary>

1. `InsufficientFundsError`: `constructor() { super('insufficient funds'); }`.
2. Thứ tự: kiểm tra `amount` → `repo.findById` → so sánh số dư.
3. Trừ trên bản sao đọc ra, rồi `this.repo.save(wallet)` và trả `wallet`. Nhớ kiểm tra đủ tiền **trước** khi trừ.

</details>

<details><summary>Bài 4: HTTP layer</summary>

1. Hai route: `app.get('/wallets/:id', ...)` và `app.post('/wallets/:id/deposit', ...)`.
2. Handler chỉ gọi `service.get` / `service.deposit` trong `try`.
3. Trong `catch`: `instanceof WalletNotFoundError` → 404, `instanceof InvalidAmountError` → 400, còn lại `throw error`.

</details>

<details><summary>Bài 5: idempotency store</summary>

1. Dùng `Map<string, { fingerprint, result }>`.
2. Gặp key đã có: so `fingerprint`; khác thì `throw new Error('IDEMPOTENCY_KEY_REUSED')`.
3. Giống thì `return { result: previous.result, replayed: true }` mà **không** gọi `work`. Key mới: gọi `work()`, lưu rồi trả `{ result, replayed: false }`.

</details>

<details><summary>Bài 6: topup endpoint</summary>

1. Bắt đầu từ `d-app.ts`; bài này thêm kiểm tra `amount` (`400`) **trước** khi tra khóa.
2. Cần thêm bộ đếm `counter` để sinh `topupId` (`t1`, `t2`, ...).
3. Lưu `{ fingerprint, status: 201, body: response }` và khi phát lại gửi `previous.status` + `previous.body` kèm `reply.header('idempotent-replayed', 'true')`.

</details>

<details><summary>Bài 7: concurrent</summary>

1. Dùng `Map<string, Promise<unknown>>`.
2. Nếu khóa đã có trong `Map` → trả Promise đó. Nếu chưa → gọi `work()` **ngay**, `set` Promise vào `Map` **trước khi** await.
3. Khi thất bại: `work().catch((error) => { inFlight.delete(key); throw error; })`; lưu chính Promise đã gắn `.catch` đó.

</details>

<details><summary>Bài 8: ledger</summary>

1. Giữ `Set` các `reference` đã dùng và `Map` số dư theo tài khoản.
2. Kiểm tra theo thứ tự đề bài: ít nhất 2 dòng → tổng bằng 0 → `reference` chưa trùng.
3. Chỉ cập nhật số dư và đánh dấu `reference` **sau khi** mọi kiểm tra đã qua, để bị từ chối thì không lưu gì.

</details>

<details><summary>Bài 9: bug key type</summary>

1. Thử `console.log(typeof id)` và `console.log([...wallets.keys()])`.
2. `'1'` (chuỗi) khác `1` (số) khi làm khóa `Map`.
3. Đổi khóa của `Map` sang chuỗi: `Map<string, string>` với `['1', 'An']`; bỏ chỗ ép kiểu.

</details>

<details><summary>Bài 10: bug save too early</summary>

1. Đọc test thứ hai: lần đầu `work` ném lỗi, lần hai phải gọi lại `work`.
2. Dòng `saved.set(key, undefined)` chạy trước `work()`.
3. Xóa nó; chỉ `saved.set(key, result)` sau khi `work()` trả về thành công.

</details>

## Kiểm tra cuối ngày (15 phút)

1. Vì sao không lưu tiền bằng số thập phân? Thay bằng gì?
2. Ba lớp HTTP / service / repository mỗi lớp chịu trách nhiệm gì?
3. Vì sao repository trả về bản sao thay vì chính đối tượng trong kho?
4. `Idempotency-Key` giải quyết vấn đề gì? Trả lời bằng tình huống nạp tiền.
5. Cùng khóa nhưng nội dung khác thì xử lý thế nào, vì sao?
6. Race condition khi hai request cùng khóa đến đồng thời xảy ra thế nào, và cách tránh?

<details><summary>Đáp án</summary>

1. Số thập phân nhị phân gây sai số (`0.1 + 0.2 !== 0.3`). Dùng số nguyên của đơn vị nhỏ nhất (cent, đồng).
2. HTTP: đọc request, gọi service, đổi lỗi thành mã trạng thái. Service: quy tắc nghiệp vụ. Repository: lưu và đọc.
3. Để thay đổi dữ liệu phải đi qua `save` có chủ đích; không ai vô tình sửa dữ liệu trong kho từ bên ngoài.
4. Khi client gửi lại vì không nhận được phản hồi, server nhận ra yêu cầu đã xử lý và trả lại kết quả cũ thay vì nạp tiền lần nữa.
5. Trả `422`: client dùng lại khóa cho một việc khác là lỗi, và nếu chấp nhận thì kết quả cũ sẽ bị hiểu sai.
6. Cả hai thấy khóa chưa có và cùng làm việc thật. Cách tránh: lưu ngay Promise (hoặc dùng ràng buộc duy nhất ở database) trước khi chờ.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| Số tiền có đuôi `.000000004` | Dùng số thập phân | Dùng số nguyên cent, làm tròn bằng `Math.round` |
| Sửa dữ liệu trong kho mà không `save` | Sửa trên bản sao | Gọi `repo.save(wallet)` sau khi sửa |
| `instanceof` luôn `false` | Lỗi không `extends Error` đúng, hoặc nhập khác file | Kiểm tra `class X extends Error` và nơi `import` |
| Test idempotency: lần hai nhận lại số dư mới thay vì cũ | Chạy lại `work` thay vì trả kết quả đã lưu | Trả đúng đối tượng đã lưu ở lần đầu |
| Khóa bị "kẹt" sau một lần lỗi | Ghi nhớ khóa trước khi việc thành công | Chỉ ghi nhớ sau khi thành công |

## Checklist: tôi đã làm được

- [ ] Giải thích được vì sao tiền dùng số nguyên và đổi qua lại giữa chuỗi và cent.
- [ ] Viết được repository, service và lớp HTTP, nói đúng việc của từng lớp.
- [ ] Tự định nghĩa một lớp lỗi và bắt đúng loại bằng `instanceof`.
- [ ] Viết được endpoint idempotent: phát lại, khác nội dung (`422`).
- [ ] Giải thích được race condition khi hai request cùng khóa đến đồng thời.
- [ ] Ít nhất 7/10 bài tập xanh (ghi số bài xanh: ___ / 10; bài 8 tùy chọn).

## Câu hỏi còn mở

- Mô hình ba lớp hôm nay là bản thu nhỏ. Dự án thật chia bốn lớp (domain, application, infrastructure, interface) và tách "cổng" (port) khỏi "bộ nối" (adapter). Ngày 7 chỉ đọc đủ để lần theo một luồng, không giải thích hết kiến trúc.
- Ghi những chỗ chưa hiểu để hỏi vào đầu Ngày 6.
