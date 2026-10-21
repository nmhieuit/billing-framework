# Ngày 2: Hàm bậc cao, module và TypeScript căn bản

> Thời lượng: 4 giờ. Hôm nay vẫn chưa đụng tới dự án. Bạn học 3 thứ dự án dùng ở mọi file: **`map`/`filter`/`reduce`**, **module** (`import`/`export`) và **TypeScript** (JavaScript có thêm kiểu dữ liệu).

## Mục tiêu

- Biến đổi, lọc và gộp một mảng bằng `map`, `filter`, `reduce` với hàm mũi tên.
- Tách code ra nhiều file bằng `export` / `import`, và dùng destructuring để lấy nhanh thuộc tính.
- Viết và chạy TypeScript bằng `tsx`; đọc được lỗi kiểu do `tsc` báo.
- Viết một `class` có trường riêng, và viết test đầu tiên bằng `vitest`.
- Làm đúng ít nhất 6/8 bài tập.

## Chuẩn bị (5 phút)

- Đã xong Ngày 1 (hoặc ít nhất 6/8 bài).
- Terminal đang ở thư mục `node-training`; tạo thư mục gõ bài: `mkdir hoc\day2`.
- Chạy `pnpm test day2`: phải thấy **đỏ** (bài chưa làm). Nếu báo "no test files found", bạn đang đứng sai thư mục.

Quy ước từ hôm nay: file `.js` chạy bằng `node file.js`; file `.ts` chạy bằng **`pnpm tsx file.ts`**. `tsx` đọc TypeScript và chạy luôn, không cần bước biên dịch riêng.

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Hàm mũi tên, `map`, `filter`, `reduce` | 20 phút |
| 2 | Module và destructuring | 20 phút |
| 3 | TypeScript: kiểu và `interface` + Bài 1-4 | 80 phút |
| 4 | `class` + Bài 6, 5 | 60 phút |
| 5 | Sửa lỗi kiểu (Bài 7) | 10 phút |
| 6 | Test đầu tiên + Bài 8 | 35 phút |
| 7 | Kiểm tra cuối ngày | 15 phút |

---

## Khối 1: Hàm mũi tên, `map`, `filter`, `reduce` (20 phút)

Ba khái niệm mới: **hàm mũi tên**, **`map` và `filter`**, **`reduce`**.

Cách viết hàm ngắn gọn: `(amount) => amount * 2` nghĩa là "nhận `amount`, trả `amount * 2`". Mảng có sẵn các phương thức nhận một hàm như vậy và áp dụng cho **từng phần tử**. Gõ `hoc/day2/a-array-methods.js`:

```js
const amounts = [10, 20, 30, 40];

const doubled = amounts.map((amount) => amount * 2);
const big = amounts.filter((amount) => amount >= 30);
const total = amounts.reduce((sum, amount) => sum + amount, 0);

console.log(doubled);
console.log(big);
console.log(total);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 3 | `map` tạo **mảng mới** cùng độ dài, mỗi phần tử là kết quả của hàm áp dụng lên phần tử cũ |
| 4 | `filter` tạo **mảng mới** chỉ giữ phần tử mà hàm trả `true` |
| 5 | `reduce` gộp cả mảng thành **một giá trị**. Hàm nhận `(sum, amount)`: `sum` là kết quả tích lũy; số `0` ở cuối là giá trị khởi đầu của `sum` |
| 7-9 | In ba kết quả. Mảng gốc `amounts` **không bị đổi** |

```text
$ node hoc/day2/a-array-methods.js
[ 20, 40, 60, 80 ]
[ 30, 40 ]
100
```

**Đoán rồi thử:** đổi `0` ở cuối `reduce` thành `1000`. Tổng đổi thế nào? (Vì `sum` bắt đầu từ 1000.)

---

## Khối 2: Module và destructuring (20 phút)

Ba khái niệm mới: **`export`**, **`import`**, **destructuring** (tách nhanh thuộc tính).

Dự án có hàng trăm file. Mỗi file **xuất** (`export`) thứ nó muốn chia sẻ, file khác **nhập** (`import`) để dùng. Gõ hai file:

`hoc/day2/b-money.js`:

```js
export const CURRENCY = 'VND';

export function formatMoney(amount) {
  return `${amount} ${CURRENCY}`;
}
```

`hoc/day2/b-main.js`:

```js
import { CURRENCY, formatMoney } from './b-money.js';

const tx = { type: 'deposit', amount: 100, note: 'nạp tiền' };
const { type, amount } = tx;

console.log(formatMoney(amount), type, CURRENCY);
```

| File, dòng | Ý nghĩa |
| ---------- | ------- |
| `b-money.js` 1, 3 | `export` đứng trước `const` / `function` để file khác dùng được |
| `b-main.js` 1 | `import { CURRENCY, formatMoney } from './b-money.js'` lấy hai thứ đã export. `./` nghĩa là "cùng thư mục". **Phải ghi đuôi `.js`** |
| `b-main.js` 4 | **Destructuring**: `const { type, amount } = tx` tách hai thuộc tính của `tx` thành hai biến, ngắn hơn `tx.type`, `tx.amount`. Thuộc tính `note` bị bỏ qua |

```text
$ node hoc/day2/b-main.js
100 VND deposit VND
```

Điều dễ gây rối: trong **TypeScript** bạn cũng ghi `from './b-money.js'` (đuôi `.js`) dù file thật là `b-money.ts`. Lý do: Node chạy code đã được chuyển sang JavaScript, nên đường dẫn phải là đường dẫn của file JavaScript. Hãy coi đó là quy tắc, không cần hiểu sâu.

---

## Khối 3: TypeScript, kiểu dữ liệu và `interface` (35 phút + bài tập)

Ba khái niệm mới: **chú thích kiểu** (`name: string`), **`interface`** (mô tả hình dạng đối tượng), **kiểm tra kiểu bằng `tsc`**.

TypeScript = JavaScript + kiểu dữ liệu ghi bên cạnh code. Nó giúp bắt lỗi **trước khi chạy**: truyền chuỗi vào chỗ cần số, gõ sai tên thuộc tính... Gõ `hoc/day2/c-types.ts`:

```ts
interface Transaction {
  type: 'deposit' | 'withdraw';
  amount: number;
}

function describe(tx: Transaction): string {
  return `${tx.type}: ${tx.amount}`;
}

console.log(describe({ type: 'deposit', amount: 100 }));
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1-4 | `interface Transaction` mô tả: một giao dịch có `type` và `amount` |
| 2 | `'deposit' \| 'withdraw'` nghĩa là `type` **chỉ được** là một trong hai chuỗi đó |
| 6 | `(tx: Transaction): string` = tham số `tx` kiểu `Transaction`, hàm trả về `string` |
| 10 | Gọi hàm với đối tượng đúng hình dạng thì hợp lệ |

Chạy bằng `tsx`:

```text
$ pnpm tsx hoc/day2/c-types.ts
deposit: 100
```

Hai điều cần phân biệt, rất quan trọng:

- **`tsx`** chỉ chạy code, **không** báo lỗi kiểu.
- **`pnpm check <file>`** (gọi `tsc`) mới kiểm tra kiểu và báo lỗi. Trong VS Code, lỗi kiểu còn hiện gạch đỏ ngay khi bạn gõ.

Gõ `hoc/day2/c-types-loi.ts` (cố ý sai) rồi kiểm tra:

```ts
interface Transaction {
  type: 'deposit' | 'withdraw';
  amount: number;
}

function describe(tx: Transaction): string {
  return `${tx.type}: ${tx.amount}`;
}

console.log(describe({ type: 'deposit', amount: '100' }));
console.log(describe({ type: 'refund', amount: 5 }));
```

```text
$ pnpm check hoc/day2/c-types-loi.ts
> node-training@ check C:/node-training
> tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2023 --skipLibCheck --types node hoc/day2/c-types-loi.ts

hoc/day2/c-types-loi.ts(10,41): error TS2322: Type 'string' is not assignable to type 'number'.
hoc/day2/c-types-loi.ts(11,24): error TS2322: Type '"refund"' is not assignable to type '"deposit" | "withdraw"'.
 ELIFECYCLE  Command failed with exit code 2.
```

Đọc lỗi: `c-types-loi.ts(10,41)` = dòng 10, cột 41. `Type 'string' is not assignable to type 'number'` = "giá trị chuỗi không gán được cho chỗ cần số". Lỗi thứ hai: `'refund'` không thuộc `'deposit' | 'withdraw'`.

Từ bài 1 đến 4, các file starter là `.ts` đã có sẵn kiểu. Lưu ý trong starter:

- Dòng `void x;` chỉ để trình soát lỗi không phàn nàn "biến chưa dùng". Khi bạn đã dùng biến thật, xóa dòng đó.
- `import type { Transaction } from './transaction.js'` = chỉ nhập **kiểu**, không nhập giá trị.

### Bài 1: nhân đôi (Cơ bản, 10 phút)

`day2/ex01-double-all.ts`, dùng `map`. Chạy `pnpm test day2/ex01`.

### Bài 2: chỉ giữ giao dịch nạp (Cơ bản, 10 phút)

`day2/ex02-only-deposits.ts`, dùng `filter`. Chạy `pnpm test day2/ex02`.

### Bài 3: số dư từ danh sách giao dịch (Trung bình, 15 phút)

`day2/ex03-balance.ts`, dùng `reduce`. Chạy `pnpm test day2/ex03`.

### Bài 4: định dạng một giao dịch (Trung bình, 10 phút)

`day2/ex04-format-transaction.ts`, dùng destructuring và template string. Chạy `pnpm test day2/ex04`.

---

## Khối 4: `class` (20 phút + bài tập)

Ba khái niệm mới: **`class` và `constructor`**, **trường riêng `#`**, **`get`** (thuộc tính tính toán).

`class` là khuôn để tạo nhiều đối tượng cùng loại, mỗi đối tượng mang **dữ liệu riêng** và **hành vi riêng**. Gõ `hoc/day2/d-class.ts`:

```ts
class Counter {
  #count = 0;

  constructor(readonly name: string) {}

  increment(): number {
    this.#count = this.#count + 1;
    return this.#count;
  }

  get value(): number {
    return this.#count;
  }
}

const visits = new Counter('visits');
visits.increment();
visits.increment();
console.log(visits.name, visits.value);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | Khai báo khuôn `Counter` |
| 2 | `#count` là **trường riêng**: chỉ code bên trong `class` mới đọc/ghi được. Bên ngoài viết `visits.#count` sẽ lỗi |
| 4 | `constructor` chạy khi tạo đối tượng; `readonly name: string` vừa khai báo tham số vừa tạo thuộc tính `name` chỉ đọc |
| 6-9 | Phương thức `increment`: tăng `#count`, trả về giá trị mới. `this` là "đối tượng đang gọi phương thức" |
| 11-13 | `get value()`: đọc như thuộc tính (`visits.value`, không có ngoặc) nhưng thực chất là hàm |
| 16 | `new Counter('visits')` tạo một đối tượng |

```text
$ pnpm tsx hoc/day2/d-class.ts
visits 2
```

### Bài 6: lớp `Wallet` (Nâng cao, 25 phút)

`day2/ex06-wallet.ts`. Đây là phiên bản "đóng gói" của ví ở Ngày 1: số dư được giấu trong `#balance`, bên ngoài chỉ đọc qua `get balance()`. Nhờ vậy **không ai sửa số dư bằng cách gán thẳng**; mọi thay đổi phải qua `deposit` / `withdraw` có kiểm tra. Chạy `pnpm test day2/ex06`.

### Bài 5: tóm tắt giao dịch nạp (Trung bình, 15 phút)

`day2/ex05-summary.ts`, ghép nhiều bước và dùng lại hàm của bài 2 qua `import`. **Làm bài 2 xong trước**, vì bài này nhập hàm `onlyDeposits` từ đó. Chạy `pnpm test day2/ex05`.

---

## Khối 5: Sửa lỗi kiểu (10 phút)

### Bài 7: TypeScript báo lỗi (Sửa lỗi)

`day2/ex07-bug-types.ts` chạy được nhưng có hai lỗi kiểu. Thông báo thật khi chưa sửa:

```text
$ pnpm check day2/ex07-bug-types.ts
> node-training@ check C:/node-training
> tsc --noEmit --strict --module nodenext --moduleResolution nodenext --target es2023 --skipLibCheck --types node day2/ex07-bug-types.ts

day2/ex07-bug-types.ts(12,3): error TS2741: Property 'balance' is missing in type '{ id: string; name: string; }' but required in type 'Customer'.
day2/ex07-bug-types.ts(18,23): error TS2551: Property 'balanse' does not exist on type 'Customer'. Did you mean 'balance'?
 ELIFECYCLE  Command failed with exit code 2.
```

Cách làm: đọc từng dòng lỗi (số dòng trong ngoặc), đọc gợi ý `Did you mean ...`, sửa. Làm xong chạy `pnpm check day2/ex07-bug-types.ts` (không còn lỗi) rồi `pnpm test day2/ex07`.

---

## Khối 6: Test đầu tiên với vitest (15 phút + bài tập)

Ba khái niệm mới: **`test(...)`**, **`expect(...).toBe(...)`**, **chạy bằng `pnpm test`**.

Bạn đã chạy test ở cả hai ngày qua; hôm nay bạn **tự viết**. Một test là một hàm nhỏ kiểm tra "với đầu vào này, kết quả phải là thế này". Gõ hai file trong `hoc/day2/`:

`e-sum.ts`:

```ts
export function sum(numbers: number[]): number {
  return numbers.reduce((total, n) => total + n, 0);
}
```

`e-sum.test.ts`:

```ts
import { expect, test } from 'vitest';
import { sum } from './e-sum.js';

test('cộng các số', () => {
  expect(sum([1, 2, 3])).toBe(6);
});

test('mảng rỗng', () => {
  expect(sum([])).toBe(0);
});
```

| Dòng của `e-sum.test.ts` | Ý nghĩa |
| ------------------------ | ------- |
| 1 | Nhập `test` và `expect` từ vitest |
| 4-6 | `test('tên', () => { ... })`: tên mô tả tình huống; hàm bên trong chứa kiểm tra |
| 5 | `expect(giá_trị).toBe(kỳ_vọng)`: không bằng thì test **đỏ** |
| 8-10 | Một tình huống khác: mảng rỗng. Mỗi tình huống nên có một `test` riêng |

Chạy test của riêng bạn:

```text
$ pnpm test hoc/day2
 RUN  v5.0.3 C:/node-training


 Test Files  1 passed (1)
      Tests  2 passed (2)
```

Quy tắc đặt tên: file test kết thúc bằng `.test.ts` và nằm cạnh file được test.

### Bài 8: tự viết test (Nâng cao, 20 phút)

`day2/ex08-discount.test.ts` (**lần này bạn sửa file test**, không sửa file `ex08-discount.ts`). Hàm `applyDiscount` đã đúng. Việc của bạn: chạy thử vài giá trị bằng `console.log` hoặc `pnpm tsx`, tự quyết định kết quả đúng là gì với các số lẻ, rồi viết tối thiểu **5 test** thay cho các dòng `test.todo`, và xóa test "XÓA SAU KHI XONG". Đạt khi `pnpm test day2/ex08` xanh, không còn dòng `todo`.

Mẹo: hãy cố tìm một test **sẽ đỏ** nếu ai đó sửa nhầm `Math.ceil` thành `Math.floor`. Test tốt là test phát hiện được lỗi.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-double-all.ts` | Cơ bản | 10' | `pnpm test day2/ex01` | xanh |
| 2 | `ex02-only-deposits.ts` | Cơ bản | 10' | `pnpm test day2/ex02` | xanh |
| 3 | `ex03-balance.ts` | Trung bình | 15' | `pnpm test day2/ex03` | xanh |
| 4 | `ex04-format-transaction.ts` | Trung bình | 10' | `pnpm test day2/ex04` | xanh |
| 5 | `ex05-summary.ts` | Trung bình | 15' | `pnpm test day2/ex05` | xanh (cần bài 2) |
| 6 | `ex06-wallet.ts` | Nâng cao | 25' | `pnpm test day2/ex06` | xanh |
| 7 | `ex07-bug-types.ts` | Sửa lỗi | 10' | `pnpm check day2/ex07-bug-types.ts` và `pnpm test day2/ex07` | không lỗi kiểu, test xanh |
| 8 | `ex08-discount.test.ts` | Nâng cao | 20' | `pnpm test day2/ex08` | ≥ 5 test xanh, không còn `todo` |

Chạy cả ngày: `pnpm test day2`. Lời giải: `node-training/solutions/day2/`.

## Gợi ý (mở từng mức)

<details><summary>Bài 1: doubleAll</summary>

1. `numbers.map(...)` trả về mảng mới.
2. Hàm bên trong nhận một số và trả số đó nhân 2.
3. `return numbers.map((n) => n * 2);`

</details>

<details><summary>Bài 2: onlyDeposits</summary>

1. `filter` giữ phần tử khi hàm trả `true`.
2. Điều kiện: `tx.type === 'deposit'`.
3. `return transactions.filter((tx) => tx.type === 'deposit');`

</details>

<details><summary>Bài 3: balanceOf</summary>

1. `reduce` với giá trị khởi đầu `0`.
2. Với mỗi `tx`: nếu `deposit` thì `balance + tx.amount`, nếu không thì `balance - tx.amount`.
3. Có thể viết `if`/`else` bên trong hàm, hoặc dùng cách viết gọn `điều_kiện ? giá_trị_nếu_đúng : giá_trị_nếu_sai`: `tx.type === 'deposit' ? balance + tx.amount : balance - tx.amount`.

</details>

<details><summary>Bài 4: formatTransaction</summary>

1. Tách `const { id, type, amount } = tx;`.
2. Chọn dấu bằng `if`/`else`, hoặc cách viết gọn `điều_kiện ? nếu_đúng : nếu_sai`: `const sign = type === 'deposit' ? '+' : '-';`.
3. `return \`${id}: ${sign}${amount}\`;`

</details>

<details><summary>Bài 5: summarize</summary>

1. Gọi `onlyDeposits(transactions)` trước, đặt tên `deposits`.
2. `count` là `deposits.length`; `ids` dùng `map`.
3. `totalDeposited` dùng `reduce` với khởi đầu `0`.

</details>

<details><summary>Bài 6: Wallet</summary>

1. Khai báo `#balance = 0;` và `constructor(readonly owner: string) {}`.
2. `get balance()` trả `this.#balance`.
3. `deposit` / `withdraw` dùng chung một hàm kiểm tra số tiền; `withdraw` kiểm tra thêm `amount > this.#balance` **trước khi** trừ, để số dư không đổi khi lỗi.

</details>

<details><summary>Bài 7: ex07-bug-types</summary>

1. Lỗi 1 ở `makeCustomer`: thiếu một thuộc tính mà `Customer` yêu cầu.
2. Lỗi 2 ở `totalBalance`: gõ sai tên thuộc tính; trình biên dịch đã gợi ý đúng tên.
3. Thêm `balance: 0` vào đối tượng trả về, và đổi `balanse` thành `balance`.

</details>

<details><summary>Bài 8: viết test</summary>

1. Mỗi dòng `test.todo('...')` là một tình huống; đổi thành `test('...', () => { ... })`.
2. Ví dụ đầu tiên: `expect(applyDiscount(1000, 10)).toBe(900);`.
3. Với lỗi ngoài khoảng: `expect(() => applyDiscount(1000, -1)).toThrow('percent must be between 0 and 100');`. Với làm tròn: thử `applyDiscount(999, 50)` rồi quyết định.

</details>

## Kiểm tra cuối ngày (15 phút)

1. Sự khác nhau giữa `map` và `filter`? `reduce` trả về gì?
2. Vì sao trong file TypeScript lại viết `from './x.js'`?
3. `tsx file.ts` và `pnpm check file.ts` khác nhau thế nào?
4. `#balance` trong `class` khác gì `balance` thường?
5. Một test tốt cần có đặc điểm gì? Vì sao nên tách mỗi tình huống thành một `test`?
6. `type Side = 'deposit' | 'withdraw'` ngăn được lỗi gì?

<details><summary>Đáp án</summary>

1. `map`: mảng mới cùng độ dài, mỗi phần tử biến đổi. `filter`: mảng mới chỉ giữ phần tử thỏa điều kiện. `reduce`: gộp cả mảng thành một giá trị.
2. Vì Node chạy code JavaScript sau khi chuyển đổi, đường dẫn phải trỏ đến file `.js`.
3. `tsx` chạy code, không báo lỗi kiểu. `pnpm check` kiểm tra kiểu, không chạy code.
4. `#balance` là trường riêng: chỉ code trong `class` truy cập được; bên ngoài không đọc/ghi trực tiếp được.
5. Kiểm tra một tình huống rõ ràng, tên mô tả đúng tình huống, đỏ khi code sai. Tách riêng để biết chính xác tình huống nào hỏng.
6. Chặn việc truyền giá trị lạ (ví dụ `'refund'`, hoặc gõ sai `'diposit'`); lỗi bị bắt trước khi chạy.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| `ERR_MODULE_NOT_FOUND` khi import | Thiếu đuôi `.js`, hoặc sai tên file | Ghi `./ten-file.js`, kiểm tra tên file |
| `Unexpected token ':'` khi chạy `node x.ts` | Chạy file TypeScript bằng `node` | Dùng `pnpm tsx x.ts` |
| Test báo `x is not a function` | Quên `export`, hoặc nhập sai tên | So tên trong `export` và `import` |
| Mảng gốc bị đổi bất ngờ | Dùng `push` / `sort` (sửa tại chỗ) thay vì `map` / `filter` (tạo mới) | Tạo mảng mới thay vì sửa mảng cũ |
| Test của bài 5 đỏ dù hàm đúng | Bài 2 chưa xong, bài 5 dùng lại hàm của bài 2 | Làm bài 2 trước |

## Checklist: tôi đã làm được

- [ ] Giải thích được `map`, `filter`, `reduce` bằng ví dụ về danh sách giao dịch.
- [ ] Tách code thành hai file và `import` / `export` được giữa chúng.
- [ ] Phân biệt được `pnpm tsx` (chạy) và `pnpm check` (kiểm tra kiểu), đọc được một lỗi kiểu.
- [ ] Viết được `class` với trường riêng `#` và `get`.
- [ ] Tự viết được một file test có ít nhất 3 tình huống.
- [ ] Ít nhất 6/8 bài tập xanh (ghi số bài xanh: ___ / 8).

## Câu hỏi còn mở

- Ghi lại chỗ chưa hiểu (đặc biệt khối 3) để hỏi vào đầu Ngày 3.
- `pnpm check` viết trong `package.json` của `node-training`, chạy bằng `tsc` với cấu hình dòng lệnh; đã chạy thật trên Linux, trên Windows **[CHƯA CHẠY]**.
