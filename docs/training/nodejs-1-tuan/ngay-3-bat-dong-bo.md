# Ngày 3: Bất đồng bộ (asynchronous)

> Thời lượng: 4 giờ. Đây là ngày quan trọng nhất của tuần: gần như mọi thứ trong wallet và payment (gọi payment, đọc database, chờ message) đều là bất đồng bộ. Hôm nay vẫn dùng ví dụ nhỏ.

## Mục tiêu

- Nói được bằng lời thường: **vì sao `await` không làm cả chương trình đứng chờ**.
- Đoán đúng thứ tự in ra của một đoạn code có `setTimeout`, `Promise` và `async/await`.
- Viết hàm trả `Promise`, dùng `async/await`, bắt lỗi bằng `try/catch`.
- Chạy nhiều việc **lần lượt** hoặc **song song** và đo được sự khác biệt.
- Đọc / ghi file JSON, và chạy một việc nền an toàn (không để lỗi "rơi" mất).
- Làm đúng ít nhất 7/9 bài tập.

## Chuẩn bị (5 phút)

- Đã xong Ngày 2 (ít nhất 6/8 bài).
- Tạo thư mục gõ bài: `mkdir hoc\day3`.
- `pnpm test day3` phải **đỏ** (bài chưa làm).

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | `setTimeout` và thứ tự chạy | 15 phút |
| 2 | `Promise` + Bài 2 | 25 phút |
| 3 | `async` / `await` / `try` / `catch` + Bài 1, 3, 4 | 55 phút |
| 4 | Lần lượt và song song + Bài 5 | 25 phút |
| 5 | Đọc / ghi file + Bài 6 | 35 phút |
| 6 | Chạy nền không chờ + Bài 7 | 30 phút |
| 7 | Bài sửa lỗi 8, 9 | 20 phút |
| 8 | Kiểm tra cuối ngày | 15 phút |

(Tổng khoảng 220 phút cộng thời gian đọc và nghỉ.)

---

## Bất đồng bộ là gì? (đọc 3 phút)

Khi wallet gọi payment, payment có thể mất 200 mili-giây để trả lời. Có hai cách chờ:

- **Đứng chờ** (đồng bộ): chương trình dừng hẳn 200ms. Trong lúc đó, mọi request khác gửi tới wallet đều phải đợi.
- **Hẹn việc, làm việc khác, được báo khi xong** (bất đồng bộ): chương trình ghi nhớ "khi payment trả lời thì chạy đoạn này", rồi quay sang phục vụ request khác.

Node làm theo cách thứ hai. Node chạy code của bạn trên **một luồng duy nhất**, nên việc chờ lâu (mạng, file, database) đều được "hẹn việc" như vậy. Ba công cụ để hẹn việc, theo thứ tự xuất hiện trong lịch sử: **callback** (`setTimeout`), **`Promise`**, và **`async/await`** (cách viết dễ đọc nhất, chạy trên nền Promise).

---

## Khối 1: `setTimeout` và thứ tự chạy (15 phút)

Ba khái niệm mới: **callback** (hàm truyền đi để gọi lại sau), **`setTimeout`**, **"đồng bộ chạy trước, hẹn giờ chạy sau"**.

Gõ `hoc/day3/a-thu-tu.js`:

```js
console.log('1. bắt đầu');

setTimeout(() => {
  console.log('3. chạy sau 0 mili-giây (nhưng vẫn chạy SAU)');
}, 0);

console.log('2. kết thúc dòng cuối');
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3-5 | `setTimeout(hàm, 0)` hẹn: "sau 0 mili-giây, gọi `hàm`". Hàm truyền đi như vậy gọi là **callback** |
| 1, 7 | Hai dòng `console.log` thường chạy ngay |

**Đoán trước khi chạy:** thứ tự in ra là 1-2-3 hay 1-3-2?

```text
$ node hoc/day3/a-thu-tu.js
1. bắt đầu
2. kết thúc dòng cuối
3. chạy sau 0 mili-giây (nhưng vẫn chạy SAU)
```

Dù hẹn 0 mili-giây, callback **vẫn chạy sau** dòng cuối. Quy tắc: Node chạy hết code đang chạy (đồng bộ) rồi mới quay lại lấy việc đã hẹn.

---

## Khối 2: Promise (25 phút)

Ba khái niệm mới: **`Promise`** (lời hứa sẽ có kết quả), **`resolve` / `reject`**, **`.then` / `.catch`**.

Promise là một đối tượng đại diện cho kết quả **chưa có nhưng sẽ có**: hoặc thành công (`resolve` kèm giá trị), hoặc thất bại (`reject` kèm lỗi). Gõ `hoc/day3/b-promise.js`:

```js
function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(() => resolve('xong'), ms);
  });
}

function failAfter(ms) {
  return new Promise((resolve, reject) => {
    setTimeout(() => reject(new Error('hỏng rồi')), ms);
  });
}

wait(100).then((value) => console.log('wait:', value));
failAfter(50).catch((error) => console.log('failAfter:', error.message));
console.log('đã đăng ký xong, chưa có kết quả nào');
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1-5 | `wait(ms)` trả về một Promise. Bên trong hẹn `setTimeout`; khi hết giờ thì gọi `resolve('xong')` |
| 7-11 | `failAfter(ms)` tương tự nhưng gọi `reject(new Error(...))`: Promise **thất bại** |
| 13 | `.then(hàm)`: khi Promise thành công, chạy `hàm` với giá trị nhận được |
| 14 | `.catch(hàm)`: khi Promise thất bại, chạy `hàm` với lỗi |
| 15 | Dòng này chạy **ngay** vì `.then` / `.catch` chỉ đăng ký, không chờ |

**Đoán:** `failAfter(50)` xong trước `wait(100)`, vậy dòng nào in trước?

```text
$ node hoc/day3/b-promise.js
đã đăng ký xong, chưa có kết quả nào
failAfter: hỏng rồi
wait: xong
```

### Bài 2: tự viết hàm chờ (Cơ bản, 10 phút)

`day3/ex02-sleep.ts`: viết `sleep(ms)` trả Promise hoàn thành sau `ms` mili-giây (mẫu: `wait` ở trên, nhưng không có giá trị). Chạy `pnpm test day3/ex02`. Từ đây bạn sẽ dùng `sleep` rất nhiều.

---

## Khối 3: `async` / `await` và `try` / `catch` (20 phút + bài tập)

Ba khái niệm mới: **`async function`**, **`await`**, **`try` / `catch` với `await`**.

`.then` lồng nhau rất khó đọc. `async/await` cho phép viết code bất đồng bộ **trông như code tuần tự**. Gõ `hoc/day3/c-async-await.js`:

```js
function wait(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function loadAmount() {
  console.log('bắt đầu tải');
  const amount = await wait(100, 250);
  console.log('tải xong:', amount);
  return amount;
}

async function main() {
  try {
    const amount = await loadAmount();
    console.log('tổng:', amount * 2);
    throw new Error('lỗi giả để thử try/catch');
  } catch (error) {
    console.log('bắt được:', error.message);
  }
}

main();
console.log('dòng này in TRƯỚC "tải xong"');
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 5 | `async function`: hàm này luôn trả về một Promise, và bên trong được phép dùng `await` |
| 7 | `await wait(100, 250)`: **tạm dừng hàm này** cho tới khi Promise xong, rồi lấy giá trị. Chỉ hàm này dừng; **chương trình khác vẫn chạy** |
| 13-19 | `try { ... } catch (error) { ... }`: nếu một `await` bên trong thất bại (hoặc có `throw`), nhảy xuống `catch` |
| 22-23 | Gọi `main()` mà không `await`, nên dòng 23 chạy tiếp ngay |

**Đoán:** dòng "dòng này in TRƯỚC..." (dòng cuối) in ở vị trí nào trong kết quả?

```text
$ node hoc/day3/c-async-await.js
bắt đầu tải
dòng này in TRƯỚC "tải xong"
tải xong: 250
tổng: 500
bắt được: lỗi giả để thử try/catch
```

Đây chính là câu trả lời cho mục tiêu đầu tiên của ngày: `await` chỉ **tạm dừng hàm đang chứa nó**. Dòng "bắt đầu tải" in ra, hàm nhường chỗ, và "dòng này in TRƯỚC" chạy ngay; 100ms sau Node quay lại chạy phần còn lại của `loadAmount`. Trong lúc hàm đang nhường chỗ, Node rảnh để phục vụ việc khác.

### Thứ tự khi có Promise và `setTimeout` cùng lúc

Quy tắc bạn cần nhớ cho các bài đoán thứ tự, từ chạy trước đến chạy sau:

1. **Code đồng bộ** đang chạy (chạy từ trên xuống hết).
2. **Microtask**: các việc `.then(...)` của Promise đã xong, và phần code **sau `await`** của một Promise đã xong. Hàng đợi này luôn được xả **hết** trước khi chuyển sang bước 3.
3. **Macrotask**: callback của `setTimeout` đã đến hạn.

Tóm gọn: **Promise xong chạy trước `setTimeout`, kể cả khi `setTimeout` hẹn 0ms.**

### Bài 1: đoán thứ tự (Cơ bản, 10 phút)

`day3/ex01-scenario.ts` (đọc) và `day3/ex01-predict.ts` (bạn ghi dự đoán vào mảng `answer`). **Đoán trước, chạy sau**: `pnpm test day3/ex01`. Dòng `await` cuối của kịch bản chỉ để đợi mọi thứ xong, bỏ qua khi đoán.

### Bài 3: đoán thứ tự có `async` (Trung bình, 10 phút)

`day3/ex03-scenario.ts` và `day3/ex03-predict.ts`. Chạy `pnpm test day3/ex03`. Lưu ý: code **trước** `await` trong hàm `async` vẫn chạy đồng bộ ngay khi gọi hàm.

### Bài 4: chia an toàn (Trung bình, 15 phút)

`day3/ex04-safe-divide.ts`: bọc `await` trong `try/catch` để biến lỗi thành kết quả `{ ok: false, error }`. Chạy `pnpm test day3/ex04`.

---

## Khối 4: Lần lượt và song song (10 phút + bài tập)

Ba khái niệm mới: **`await` liên tiếp (lần lượt)**, **`Promise.all` (song song)**, **đo thời gian bằng `Date.now()`**.

Hai việc độc lập (ví dụ gọi hai dịch vụ khác nhau) không cần chờ nhau. Gõ `hoc/day3/d-song-song.js`:

```js
function wait(ms, value) {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

async function main() {
  let start = Date.now();
  const a = await wait(200, 'a');
  const b = await wait(200, 'b');
  console.log('lần lượt:', a, b, `${Date.now() - start}ms`);

  start = Date.now();
  const results = await Promise.all([wait(200, 'a'), wait(200, 'b')]);
  console.log('song song:', results, `${Date.now() - start}ms`);
}

main();
```

```text
$ node hoc/day3/d-song-song.js
lần lượt: a b 402ms
song song: [ 'a', 'b' ] 201ms
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 7-8 | Hai `await` liên tiếp: việc thứ hai chỉ **bắt đầu** sau khi việc thứ nhất xong. Tổng thời gian ≈ 200 + 200 |
| 12 | `Promise.all([...])` khởi động cả hai cùng lúc và chờ cả hai. Tổng ≈ 200. Kết quả là mảng theo **đúng thứ tự** truyền vào |
| 6, 9, 11, 13 | `Date.now()` là thời điểm hiện tại tính bằng mili-giây; hiệu của hai lần đo là thời gian chạy |

(Con số ms thực tế có thể lệch vài mili-giây.)

Lưu ý: chỉ song song khi hai việc **không phụ thuộc nhau**. Nếu việc 2 cần kết quả của việc 1 thì phải `await` lần lượt.

### Bài 5: lần lượt và song song (Trung bình, 15 phút)

`day3/ex05-sequential-parallel.ts`: viết `runSequential` và `runParallel`. Test đo thời gian thật: lần lượt phải mất ≈ 300ms, song song ≈ 100ms. Chạy `pnpm test day3/ex05`.

---

## Khối 5: Đọc / ghi file và JSON (15 phút + bài tập)

Ba khái niệm mới: **`readFile` / `writeFile`** (dạng Promise), **JSON** (`JSON.stringify` / `JSON.parse`), **mã lỗi `error.code`**.

Gõ `hoc/day3/e-tep.js`:

```js
import { mkdir, readFile, writeFile } from 'node:fs/promises';

async function main() {
  await mkdir('tmp', { recursive: true });

  const wallet = { owner: 'An', balance: 150 };
  await writeFile('tmp/wallet.json', JSON.stringify(wallet, null, 2));

  const text = await readFile('tmp/wallet.json', 'utf8');
  const loaded = JSON.parse(text);
  console.log(text);
  console.log(loaded.owner, loaded.balance);

  try {
    await readFile('tmp/khong-co.json', 'utf8');
  } catch (error) {
    console.log('lỗi đọc file:', error.code);
  }
}

main();
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | Nhập hàm làm việc với file từ phần có sẵn của Node (`node:fs/promises`), tất cả đều trả Promise |
| 4 | Tạo thư mục `tmp` nếu chưa có |
| 7 | `JSON.stringify(wallet, null, 2)` đổi đối tượng thành **chuỗi JSON** (thụt lề 2 ký tự) để ghi file |
| 9-10 | Đọc file thành chuỗi, rồi `JSON.parse` đổi ngược chuỗi thành đối tượng |
| 14-18 | Đọc file không tồn tại sẽ ném lỗi; lỗi có `error.code === 'ENOENT'` ("không có file hoặc thư mục") |

```text
$ node hoc/day3/e-tep.js
{
  "owner": "An",
  "balance": 150
}
An 150
lỗi đọc file: ENOENT
```

### Bài 6: lưu và nạp ví (Trung bình, 20 phút)

`day3/ex06-wallet-file.ts`: `saveWallet` ghi file, `loadWallet` đọc lại; file không tồn tại thì trả `null`, còn lỗi khác (ví dụ file JSON hỏng) phải **ném tiếp**. Vì sao không bắt mọi lỗi? Vì nuốt lỗi lạ sẽ làm bạn không bao giờ biết chuyện gì đã sai. Chạy `pnpm test day3/ex06`.

---

## Khối 6: Chạy nền không chờ (10 phút + bài tập)

Ba khái niệm mới: **fire-and-forget** (bắn rồi quên), **`.catch` bắt buộc**, **lỗi "rơi" (unhandled rejection)**.

Tình huống thật: người dùng gửi `POST /topups`; server trả lời ngay "đã nhận", còn việc gửi sang payment làm ở nền. Nếu việc nền thất bại mà **không ai bắt lỗi**, Promise lỗi đó trở thành *unhandled rejection* và (mặc định) làm chương trình Node sập. Gõ `hoc/day3/f-chay-nen.js`:

```js
function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendEmail() {
  await wait(100);
  throw new Error('gửi mail thất bại');
}

function handleRequest() {
  sendEmail().catch((error) => console.log('đã bắt lỗi chạy nền:', error.message));
  return 'trả lời ngay, không chờ email';
}

console.log(handleRequest());
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 5-8 | `sendEmail` chờ 100ms rồi thất bại |
| 11 | Gọi `sendEmail()` mà **không `await`**, nhưng nối `.catch(...)` để xử lý lỗi |
| 12 | Hàm trả về ngay, không chờ email |

```text
$ node hoc/day3/f-chay-nen.js
trả lời ngay, không chờ email
đã bắt lỗi chạy nền: gửi mail thất bại
```

Thử xóa đoạn `.catch(...)` (chỉ còn `sendEmail();`) rồi chạy lại: Node sẽ in lỗi và dừng chương trình. Bài học: **mọi Promise chạy nền đều phải có `.catch`**.

### Bài 7: chạy nền an toàn (Nâng cao, 20 phút)

`day3/ex07-fire-and-forget.ts`. Test kiểm tra ba điều: hàm trả về ngay, lỗi bất đồng bộ đến được `onError`, và lỗi đồng bộ cũng đến được `onError` thay vì ném ra ngoài. Chạy `pnpm test day3/ex07`. Đây là phiên bản thu nhỏ của đúng thứ dự án dùng khi gửi top-up sang payment (bạn sẽ gặp ở Ngày 6 và 7).

---

## Khối 7: Bài sửa lỗi (20 phút)

### Bài 8: tổng ra 0 (Sửa lỗi, 10 phút)

`day3/ex08-bug-foreach.ts`. Chạy `pnpm test day3/ex08` và quan sát: `Received 0`. Hỏi: `forEach` có biết chờ hàm `async` của nó không? (Không: nó gọi hàm rồi đi tiếp, không đợi Promise.) Thay bằng vòng lặp `for...of` có `await` bên trong.

### Bài 9: `try/catch` không bắt được lỗi (Sửa lỗi, 10 phút)

`day3/ex09-bug-try-catch.ts`. Chạy `pnpm test day3/ex09`. Lỗi vẫn "lọt" ra ngoài dù đã có `try/catch`. Gợi ý: `return load();` trả về Promise **chưa xong**; hàm thoát khỏi `try` trước khi Promise thất bại. Thiếu đúng một từ khóa.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-predict.ts` | Cơ bản | 10' | `pnpm test day3/ex01` | xanh |
| 2 | `ex02-sleep.ts` | Cơ bản | 10' | `pnpm test day3/ex02` | xanh |
| 3 | `ex03-predict.ts` | Trung bình | 10' | `pnpm test day3/ex03` | xanh |
| 4 | `ex04-safe-divide.ts` | Trung bình | 15' | `pnpm test day3/ex04` | xanh |
| 5 | `ex05-sequential-parallel.ts` | Trung bình | 15' | `pnpm test day3/ex05` | xanh |
| 6 | `ex06-wallet-file.ts` | Trung bình | 20' | `pnpm test day3/ex06` | xanh |
| 7 | `ex07-fire-and-forget.ts` | Nâng cao | 20' | `pnpm test day3/ex07` | xanh |
| 8 | `ex08-bug-foreach.ts` | Sửa lỗi | 10' | `pnpm test day3/ex08` | xanh |
| 9 | `ex09-bug-try-catch.ts` | Sửa lỗi | 10' | `pnpm test day3/ex09` | xanh |

Chạy cả ngày: `pnpm test day3`. Lời giải: `node-training/solutions/day3/`.

## Gợi ý (mở từng mức)

<details><summary>Bài 1 và 3: đoán thứ tự</summary>

1. Ghi từng dòng của kịch bản ra giấy theo 3 nhóm: đồng bộ / microtask / macrotask.
2. Mọi `log` đồng bộ trước; rồi `.then` và phần sau `await`; cuối cùng `setTimeout`.
3. Bài 1 chia nhóm: đồng bộ = A, D; microtask = C; macrotask = B. Bài 3: phần sau `await Promise.resolve()` trong `task` được xếp hàng trước `.then` ở dòng sau (vì `await` đó được gặp trước).

</details>

<details><summary>Bài 2: sleep</summary>

1. Trả về `new Promise(...)`.
2. Bên trong Promise, gọi `setTimeout(...)`.
3. `return new Promise((resolve) => { setTimeout(resolve, ms); });`

</details>

<details><summary>Bài 4: safeDivide</summary>

1. Bọc `await divideAsync(a, b)` trong `try`.
2. Thành công thì `return { ok: true, value }`.
3. Trong `catch (error)`, `return { ok: false, error: (error as Error).message }`.

</details>

<details><summary>Bài 5: lần lượt / song song</summary>

1. Lần lượt: duyệt `tasks` bằng `for...of`, `await task()` rồi `push` kết quả.
2. Song song: `tasks.map((task) => task())` tạo mảng Promise **đã khởi động**.
3. `return Promise.all(tasks.map((task) => task()));`

</details>

<details><summary>Bài 6: wallet file</summary>

1. `saveWallet`: `await writeFile(path, JSON.stringify(wallet))`.
2. `loadWallet`: `await readFile(path, 'utf8')` rồi `JSON.parse`, tất cả trong `try`.
3. Trong `catch`: nếu `(error as NodeJS.ErrnoException).code === 'ENOENT'` thì `return null`, nếu không thì `throw error`.

</details>

<details><summary>Bài 7: runInBackground</summary>

1. Lỗi đồng bộ và bất đồng bộ đều cần vào cùng một chỗ: dùng một hàm `async` nhỏ bọc `task()`.
2. Gọi hàm `async` đó ngay (dấu `()` ở cuối) để lấy Promise.
3. `(async () => { await task(); })().catch(onError);`

</details>

<details><summary>Bài 8: forEach</summary>

1. `forEach` không chờ Promise của callback `async`.
2. Dùng `for (const id of ids)`.
3. Trong vòng lặp: `total += await loadAmount(id);`

</details>

<details><summary>Bài 9: try/catch</summary>

1. `try/catch` chỉ bắt lỗi xảy ra **bên trong** `try` trong lúc nó còn đang chạy.
2. `return load();` thoát khỏi `try` ngay khi có Promise, chưa chờ.
3. `return await load();`

</details>

## Kiểm tra cuối ngày (15 phút)

1. Vì sao `await` không làm cả chương trình đứng chờ?
2. Đoán thứ tự: `console.log(1); setTimeout(() => console.log(2), 0); Promise.resolve().then(() => console.log(3)); console.log(4);`
3. Khi nào dùng `Promise.all`, khi nào `await` lần lượt?
4. Vì sao `ids.forEach(async ...)` không đúng khi bạn cần chờ tất cả xong?
5. Nếu một Promise chạy nền thất bại mà không có `.catch`, chuyện gì xảy ra?
6. `JSON.stringify` và `JSON.parse` làm gì?

<details><summary>Đáp án</summary>

1. `await` chỉ tạm dừng **hàm chứa nó**; Node nhường luồng cho việc khác và quay lại khi Promise xong.
2. `1, 4, 3, 2`: đồng bộ (1, 4), rồi microtask (3), rồi `setTimeout` (2).
3. `Promise.all` khi các việc độc lập nhau; `await` lần lượt khi việc sau cần kết quả của việc trước.
4. `forEach` không chờ Promise của callback; hàm bên ngoài tiếp tục chạy (và trả kết quả) trước khi các `await` bên trong xong.
5. Thành *unhandled rejection*: mặc định Node in lỗi và dừng chương trình.
6. `stringify`: đối tượng → chuỗi JSON. `parse`: chuỗi JSON → đối tượng.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| Kết quả là `Promise { <pending> }` | Quên `await` | Thêm `await` trước lời gọi hàm `async` |
| `await is only valid in async function` | Dùng `await` trong hàm thường | Thêm `async` trước `function` / trước `(...) =>` |
| `UnhandledPromiseRejection` làm sập chương trình | Promise thất bại không có `.catch` / `try-catch` | Thêm `.catch` hoặc `await` trong `try/catch` |
| Hai việc chạy tuần tự dù tưởng song song | `await` từng việc thay vì `Promise.all` | Khởi động cả hai trước, rồi `await Promise.all([...])` |
| Test bất đồng bộ "xanh giả" | Quên `await` trước `expect(...)` hoặc quên `async` ở test | Test dùng `async () => { ... await ... }` |

## Checklist: tôi đã làm được

- [ ] Giải thích được bằng lời thường vì sao `await` không chặn cả chương trình.
- [ ] Đoán đúng thứ tự của đoạn có `setTimeout`, `.then`, `await`.
- [ ] Viết được hàm trả `Promise` và hàm `async` có `try/catch`.
- [ ] Phân biệt và đo được lần lượt vs song song.
- [ ] Biết vì sao Promise chạy nền luôn cần `.catch`.
- [ ] Ít nhất 7/9 bài tập xanh (ghi số bài xanh: ___ / 9).

## Câu hỏi còn mở

- Phần "microtask / macrotask" ở trên là bản rút gọn. Bản đầy đủ (thêm `process.nextTick`, `setImmediate`) không cần thiết cho tuần này; hỏi nếu bạn muốn học thêm.
- Ghi những chỗ chưa hiểu để hỏi vào đầu Ngày 4.
