# Ngày 1: Chạy chương trình đầu tiên và JavaScript căn bản

> Thời lượng: 4 giờ. Hôm nay bạn chưa đụng tới dự án `billing-framework`. Bạn chỉ làm quen với việc **gõ code, chạy, đọc lỗi, sửa lỗi**.

## Mục tiêu

Sau hôm nay bạn tự làm được:

- Chạy một file JavaScript bằng lệnh `node` và đọc được thông báo lỗi (file nào, dòng nào, lỗi gì).
- Dùng biến (`const`, `let`), ba kiểu dữ liệu cơ bản (chuỗi, số, đúng/sai) và template string.
- Viết hàm, câu điều kiện `if`, mảng với vòng lặp, và đối tượng (object).
- Làm đúng ít nhất 6/8 bài tập, mỗi bài tự chấm bằng test (xanh = đạt).

## Cách học mỗi ngày (đọc 1 lần, dùng cho cả 7 ngày)

1. **Gõ lại từng dòng** code ở phần "Bài học" vào file của bạn trong thư mục `hoc/dayN/` (thư mục này do bạn tự tạo, nằm trong `node-training/`, Git bỏ qua). Không dán.
2. Trước khi chạy, **đoán kết quả** trong đầu hoặc ghi ra giấy. Rồi mới chạy và so sánh.
3. Muốn chắc chắn, đổi một chỗ nhỏ trong code (đổi số, đổi chữ) rồi chạy lại xem điều gì đổi.
4. Làm bài tập: sửa file trong `node-training/dayN/exNN-*.js` (chỗ có `// TODO`), chạy test của bài đó. Đỏ = chưa đạt, xanh = đạt.
5. **Chỉ mở lời giải** trong `node-training/solutions/dayN/` sau khi đã thử và dùng hết 3 mức gợi ý.
6. File mẫu của các ví dụ nằm ở `node-training/examples/dayN/`. Chỉ mở khi gõ mãi không ra kết quả giống sách.

## Chuẩn bị (20 phút)

Máy: Windows, VS Code, terminal PowerShell. Các lệnh trong sách này viết cho PowerShell và cũng chạy được trên Linux/macOS.

| Bước | Lệnh | Kết quả mong đợi |
| ---- | ---- | ---------------- |
| 1 | `node --version` | `v22.x.x` (dự án dùng Node 22; thấy số nhỏ hơn thì cài lại Node 22 từ nodejs.org) |
| 2 | `corepack enable` | Không in gì. Nếu báo thiếu quyền, mở PowerShell bằng "Run as administrator" chạy lại một lần |
| 3 | `cd node-training` (từ thư mục gốc của repo) | Dấu nhắc lệnh đổi sang thư mục `node-training` |
| 4 | `pnpm install` | Cài xong trong vài chục giây, có thư mục `node_modules` |
| 5 | `pnpm test day1/ex01` | **Đỏ** (2 test fail). Đúng như mong đợi: bài 1 chưa làm |

Nếu gõ `pnpm` báo không tìm thấy, thêm `corepack` vào đầu mọi lệnh: `corepack pnpm install`.

> Ghi chú của người biên soạn: các lệnh trên đã chạy thật trên Linux với Node 22. Trên Windows **[CHƯA CHẠY]**; nếu có chỗ khác, ghi vào phần "Câu hỏi còn mở" cuối bài.

Tạo thư mục để gõ bài học: `mkdir hoc\day1` (PowerShell) rồi mở thư mục `node-training` bằng VS Code (`code .`).

## Lịch trong ngày

| Khối | Nội dung | Thời gian |
| ---- | -------- | --------- |
| 1 | Chạy chương trình đầu tiên, đọc lỗi | 30 phút |
| 2 | Biến, kiểu dữ liệu, template string | 30 phút |
| 3 | Hàm, điều kiện + Bài 1, 2 | 50 phút |
| 4 | Mảng và vòng lặp + Bài 3, 4 | 45 phút |
| 5 | Đối tượng + Bài 5, 6 | 50 phút |
| 6 | Bài sửa lỗi 7, 8 | 20 phút |
| 7 | Kiểm tra cuối ngày | 15 phút |

---

## Khối 1: Chạy chương trình đầu tiên (30 phút)

Ba khái niệm mới: **chạy file bằng `node`**, **`console.log`**, **thông báo lỗi**.

JavaScript là ngôn ngữ lập trình. **Node.js** (gọi tắt là Node) là chương trình đọc file JavaScript và chạy nó trên máy bạn. Mọi thứ trong dự án này (wallet, payment) đều là chương trình Node.

Tạo file `hoc/day1/a-hello.js` và gõ:

```js
console.log('Xin chào Node.js');
console.log(1 + 2);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | `console.log(...)` in giá trị trong ngoặc ra màn hình. Chữ nằm giữa dấu nháy `'...'` là một **chuỗi** (string) |
| 2 | Có thể in cả phép tính: `1 + 2` được tính ra `3` rồi mới in |

Chạy:

```text
$ node hoc/day1/a-hello.js
Xin chào Node.js
3
```

**Đoán rồi chạy:** nếu đổi dòng 2 thành `console.log('1' + '2');` thì in ra gì? (Gợi ý: cộng hai chuỗi.) Thử và so sánh.

### Đọc thông báo lỗi

Lỗi là chuyện bình thường. Việc cần học là **đọc** nó. Tạo `hoc/day1/a-loi.js`:

```js
console.log('Dòng này chạy được');
console.log(tenBien);
console.log('Dòng này không bao giờ chạy tới');
```

Chạy (chỉ hiện phần đầu của kết quả):

```text
$ node hoc/day1/a-loi.js
Dòng này chạy được
file:///C:/node-training/hoc/day1/a-loi.js:2
console.log(tenBien);
            ^

ReferenceError: tenBien is not defined
    at file:///C:/node-training/hoc/day1/a-loi.js:2:13
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
```

Cách đọc, từ trên xuống:

| Phần của thông báo | Cho bạn biết |
| ------------------ | ------------ |
| `Dòng này chạy được` | Dòng 1 đã chạy xong. Lỗi xảy ra **sau** đó |
| `...a-loi.js:2` | Lỗi ở **dòng 2** của file `a-loi.js` |
| Dòng có dấu `^` | Đúng đoạn code bị lỗi |
| `ReferenceError: tenBien is not defined` | Loại lỗi (`ReferenceError`: dùng tên chưa khai báo) và mô tả (`tenBien` chưa được định nghĩa) |
| Các dòng `at ...` | **Stack trace**: chuỗi các nơi dẫn tới lỗi, dòng trên cùng là gần lỗi nhất. Các dòng `node:internal` là của Node, bỏ qua |

Dòng 3 không bao giờ chạy: gặp lỗi là chương trình dừng.

**Thử:** sửa `tenBien` thành `'tenBien'` (có dấu nháy) cho hết lỗi. Chạy lại.

---

## Khối 2: Biến, kiểu dữ liệu, template string (30 phút)

Ba khái niệm mới: **`const` / `let`**, **ba kiểu dữ liệu** (chuỗi, số, đúng/sai), **template string**.

Biến là cái hộp có tên để cất một giá trị. Tạo `hoc/day1/b-bien.js`:

```js
const name = 'An';
let balance = 100;
balance = balance + 50;
const isActive = true;

console.log(name, balance, isActive);
console.log(typeof name, typeof balance, typeof isActive);
console.log(`Ví của ${name} có ${balance} đồng`);
console.log(7 % 2, 10 / 4, 3 * 5);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | `const name = 'An'` tạo biến `name` chứa chuỗi `An`. `const` = **không được gán lại** |
| 2 | `let balance = 100` tạo biến `balance` chứa số. `let` = **được gán lại** |
| 3 | Gán lại: `balance` thành `150` |
| 4 | `true` / `false` là kiểu **boolean** (đúng/sai) |
| 6 | `console.log` in được nhiều giá trị cùng lúc, cách nhau dấu phẩy |
| 7 | `typeof x` cho biết kiểu của `x` |
| 8 | **Template string**: chuỗi nằm trong dấu huyền `` ` `` (phím bên trái số 1), chèn giá trị bằng `${...}` |
| 9 | Phép tính: `%` là **chia lấy dư** (7 chia 2 dư 1), `/` chia, `*` nhân |

Kết quả:

```text
$ node hoc/day1/b-bien.js
An 150 true
string number boolean
Ví của An có 150 đồng
1 2.5 15
```

### `const` không cho gán lại

Gõ `hoc/day1/b-hang.js` rồi chạy:

```js
const name = 'An';
name = 'Bình';
console.log(name);
```

```text
$ node hoc/day1/b-hang.js
file:///C:/node-training/hoc/day1/b-hang.js:2
name = 'Bình';
     ^

TypeError: Assignment to constant variable.
    at file:///C:/node-training/hoc/day1/b-hang.js:2:6
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
```

Đọc lỗi: `TypeError: Assignment to constant variable` = "gán lại cho biến `const`". Quy tắc dễ nhớ: **dùng `const` trước; chỉ đổi thành `let` khi thật sự cần gán lại**.

---

## Khối 3: Hàm và điều kiện (50 phút)

Ba khái niệm mới: **hàm và `return`**, **`if` / `else`**, **so sánh và toán tử logic** (`===`, `>`, `&&`, `||`, `!`).

Hàm là một đoạn code có tên, nhận đầu vào và trả đầu ra. Tạo `hoc/day1/c-ham.js`:

```js
function describeBalance(balance) {
  if (balance > 1000) {
    return 'nhiều';
  }
  return 'ít';
}

console.log(describeBalance(5000));
console.log(describeBalance(200));
console.log(5 === 5, 5 === '5');

function canWithdraw(balance, amount) {
  return amount > 0 && amount <= balance;
}
console.log(canWithdraw(100, 30), canWithdraw(100, 500), !canWithdraw(100, 500));
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | Khai báo hàm tên `describeBalance`, nhận 1 đầu vào gọi là `balance` |
| 2-4 | Nếu `balance > 1000` thì hàm **trả về** chữ `'nhiều'` và dừng ngay |
| 5 | Không rơi vào `if` thì trả về `'ít'` |
| 8-9 | **Gọi** hàm: đưa giá trị vào ngoặc, nhận kết quả để in |
| 10 | `===` so sánh **bằng nhau cả giá trị lẫn kiểu**: số `5` khác chuỗi `'5'`. Luôn dùng `===`, không dùng `==` |
| 12-14 | `&&` nghĩa là "và": cả hai vế phải đúng. `\|\|` nghĩa là "hoặc", `!` là "phủ định" (đảo đúng thành sai) |
| 15 | In 3 kết quả: `true false true` |

```text
$ node hoc/day1/c-ham.js
nhiều
ít
true false
true false true
```

**Đoán:** `canWithdraw(100, 0)` trả về gì? (Vế đầu `amount > 0` sai.) Thử bằng cách thêm một dòng `console.log`.

### Bài 1: lời chào (Cơ bản, 10 phút)

Mở `node-training/day1/ex01-greet.js` và hoàn thành hàm `greet` (dùng `return` và template string của khối 2).

```bash
pnpm test day1/ex01
```

Khi chưa làm, kết quả là **đỏ**. Đây là phần đầu thông báo:

```text
$ pnpm test day1/ex01
> node-training@ test C:/node-training
> vitest run day1/ex01


 RUN  v5.0.3 C:/node-training

 ❯ day1/ex01-greet.test.js (2 tests | 2 failed)
   × chào một người
   × chào người khác

 Test Files  1 failed (1)
      Tests  2 failed (2)

 ELIFECYCLE  Test failed. See above for more details.
```

Cách đọc: `expected` (kỳ vọng) là điều test muốn thấy; `Received` (nhận được) là điều hàm của bạn trả về. Hiện `undefined` nghĩa là hàm chưa trả gì. Làm xong, kết quả phải **xanh**:

```text
$ pnpm test day1/ex01
> node-training@ test C:/node-training
> vitest run day1/ex01


 RUN  v5.0.3 C:/node-training


 Test Files  1 passed (1)
      Tests  2 passed (2)
```

### Bài 2: số chẵn (Cơ bản, 10 phút)

File `day1/ex02-is-even.js`. Phép `%` ở khối 2 sẽ giúp bạn. Chạy `pnpm test day1/ex02`.

---

## Khối 4: Mảng và vòng lặp (45 phút)

Ba khái niệm mới: **mảng**, **vòng lặp `for...of`**, **`push` và `length`**.

Mảng là danh sách có thứ tự, đánh số từ **0**. Tạo `hoc/day1/d-mang.js`:

```js
const amounts = [10, 20, 30];
amounts.push(40);

let total = 0;
for (const amount of amounts) {
  total = total + amount;
}

console.log(amounts.length, total);
console.log(amounts[0], amounts[amounts.length - 1]);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | Mảng 3 số, viết trong `[ ]` |
| 2 | `push(40)` thêm phần tử vào cuối |
| 4 | Biến `total` để cộng dồn, bắt đầu từ 0 |
| 5-7 | `for (const amount of amounts)` = "với mỗi phần tử trong mảng, đặt tên nó là `amount`, chạy khối bên trong" |
| 6 | Cộng dồn vào `total` |
| 9 | `amounts.length` là số phần tử |
| 10 | Phần tử đầu là `amounts[0]`; phần tử cuối là `amounts[amounts.length - 1]` (vì đánh số từ 0) |

```text
$ node hoc/day1/d-mang.js
4 100
10 40
```

Mẹo nhỏ để làm bài 4: chuỗi cũng có "phương thức". `'xin chào'.split(' ')` cắt chuỗi thành mảng `['xin', 'chào']`. Nếu có hai dấu cách liền nhau, bạn sẽ nhận được phần tử rỗng `''`.

### Bài 3: tổng và lớn nhất (Cơ bản, 15 phút)

`day1/ex03-sum-max.js`. Chạy `pnpm test day1/ex03`.

### Bài 4: đếm từ (Trung bình, 20 phút)

`day1/ex04-count-words.js`. Chạy `pnpm test day1/ex04`.

---

## Khối 5: Đối tượng (50 phút)

Ba khái niệm mới: **đối tượng (object)**, **mảng chứa đối tượng**, **`throw new Error`**.

Đối tượng gom nhiều giá trị có tên vào một chỗ: `{ tên: giá trị }`. Đây là cách mô tả một "ví", một "giao dịch"... Tạo `hoc/day1/e-doi-tuong.js`:

```js
const wallet = { owner: 'An', balance: 100 };
wallet.balance = wallet.balance + 50;
console.log(wallet.owner, wallet.balance);

const transactions = [
  { type: 'deposit', amount: 100 },
  { type: 'withdraw', amount: 30 },
];
for (const tx of transactions) {
  console.log(tx.type, tx.amount);
}

function withdraw(wallet, amount) {
  if (amount > wallet.balance) {
    throw new Error('Không đủ tiền');
  }
  wallet.balance = wallet.balance - amount;
}
withdraw(wallet, 1000);
```

| Dòng | Ý nghĩa |
| ---- | ------- |
| 1 | Đối tượng `wallet` có hai **thuộc tính** (property): `owner` và `balance` |
| 2 | Đọc và ghi thuộc tính bằng dấu chấm. Lưu ý: `const wallet` không cho gán lại **biến**, nhưng vẫn sửa được thuộc tính bên trong |
| 5-8 | Mảng chứa các đối tượng: cách thường gặp nhất để mô tả danh sách |
| 9-11 | Duyệt mảng, mỗi lần `tx` là một đối tượng |
| 13-18 | `throw new Error('...')` **báo lỗi**: hàm dừng ngay, chương trình dừng nếu không ai xử lý |
| 19 | Rút 1000 trong khi chỉ có 150, nên dòng này gây lỗi |

```text
$ node hoc/day1/e-doi-tuong.js
An 150
deposit 100
withdraw 30
file:///C:/node-training/hoc/day1/e-doi-tuong.js:15
    throw new Error('Không đủ tiền');
          ^

Error: Không đủ tiền
    at withdraw (file:///C:/node-training/hoc/day1/e-doi-tuong.js:15:11)
    at file:///C:/node-training/hoc/day1/e-doi-tuong.js:19:1
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
```

Lỗi `Error: Không đủ tiền` do **chính ta** ném ra. Dòng `at withdraw (...:15:11)` cho biết nó được ném trong hàm `withdraw` ở dòng 15, và dòng dưới cho biết hàm được gọi ở dòng 19. Đọc stack trace từ trên xuống là đi ngược từ nơi báo lỗi về nơi gọi.

Mẹo cho bài 5: `Number.isInteger(x)` trả `true` nếu `x` là số nguyên (ví dụ `5`), `false` nếu không (ví dụ `1.5`, `'5'`).

### Bài 5: ví có nạp tiền (Trung bình, 25 phút)

`day1/ex05-wallet.js`. Chạy `pnpm test day1/ex05`.

### Bài 6: tổng theo loại giao dịch (Nâng cao, 25 phút)

`day1/ex06-totals.js`. Chạy `pnpm test day1/ex06`. Đây là bài khó nhất của ngày; nếu bí, xem gợi ý từng mức.

---

## Khối 6: Bài sửa lỗi (20 phút)

Hai bài này có sẵn code **đã sai**. Quy trình: chạy test → đọc `expected` / `Received` → tìm dòng sai → sửa đúng 1 chỗ → chạy lại.

### Bài 7: trung bình ra `NaN` (Sửa lỗi)

`day1/ex07-bug-average.js`. Chạy `pnpm test day1/ex07`.

```text
$ pnpm test day1/ex07
> node-training@ test C:/node-training
> vitest run day1/ex07


 RUN  v5.0.3 C:/node-training

 ❯ day1/ex07-bug-average.test.js (2 tests | 1 failed)
   × trung bình

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)

```

`NaN` nghĩa là "Not a Number", kết quả của phép tính vô nghĩa. Hỏi: số phần tử là 3 thì chỉ số hợp lệ là 0, 1, 2. Vòng lặp có chạy tới chỉ số 3 không?

### Bài 8: cộng hai ô nhập liệu (Sửa lỗi)

`day1/ex08-bug-add-amounts.js`. Chạy `pnpm test day1/ex08`. Dữ liệu người dùng gõ vào luôn là **chuỗi**, và `'10' + '5'` cho `'105'`. Hàm `Number('10')` đổi chuỗi thành số; với chữ không phải số, `Number('abc')` cho `NaN`, và `Number.isNaN(x)` kiểm tra điều đó.

---

## Danh sách bài tập

| Bài | File | Mức | Thời gian | Lệnh | Đạt khi |
| --- | ---- | --- | --------- | ---- | ------- |
| 1 | `ex01-greet.js` | Cơ bản | 10' | `pnpm test day1/ex01` | 2/2 test xanh |
| 2 | `ex02-is-even.js` | Cơ bản | 10' | `pnpm test day1/ex02` | 2/2 |
| 3 | `ex03-sum-max.js` | Cơ bản | 15' | `pnpm test day1/ex03` | 2/2 |
| 4 | `ex04-count-words.js` | Trung bình | 20' | `pnpm test day1/ex04` | 3/3 |
| 5 | `ex05-wallet.js` | Trung bình | 25' | `pnpm test day1/ex05` | 3/3 |
| 6 | `ex06-totals.js` | Nâng cao | 25' | `pnpm test day1/ex06` | 3/3 |
| 7 | `ex07-bug-average.js` | Sửa lỗi | 10' | `pnpm test day1/ex07` | 2/2 |
| 8 | `ex08-bug-add-amounts.js` | Sửa lỗi | 10' | `pnpm test day1/ex08` | 3/3 |

Chạy cả ngày một lần: `pnpm test day1`. Lời giải: `node-training/solutions/day1/` (cùng tên file).

## Gợi ý (mở từng mức, đừng mở hết một lúc)

<details><summary>Bài 1: greet</summary>

1. Hàm cần trả về một chuỗi bằng từ khóa `return`.
2. Dùng template string: dấu huyền `` ` `` và `${name}`.
3. Dạng đầy đủ: `` return `Xin chào, ${name}!`; ``

</details>

<details><summary>Bài 2: isEven</summary>

1. Số chẵn là số chia 2 dư 0.
2. Phép chia lấy dư là `%`.
3. `n % 2 === 0` đã là một biểu thức cho ra `true`/`false`, trả thẳng nó về.

</details>

<details><summary>Bài 3: sum và max</summary>

1. `sum`: khai báo `let total = 0`, dùng `for...of` cộng dồn, rồi trả `total`.
2. `max`: mảng rỗng thì trả `undefined` ngay (kiểm tra `numbers.length === 0`).
3. `max`: đặt `best = numbers[0]`, duyệt từng số, số nào lớn hơn `best` thì gán lại `best`.

</details>

<details><summary>Bài 4: countWords</summary>

1. `text.split(' ')` ra một mảng các mảnh; có thể có mảnh rỗng.
2. Dùng biến đếm `count`, duyệt từng mảnh.
3. Chỉ tăng `count` khi mảnh `!== ''`.

</details>

<details><summary>Bài 5: wallet</summary>

1. `createWallet` trả về đối tượng `{ owner: owner, balance: 0 }`.
2. `deposit`: kiểm tra hợp lệ trước (`!Number.isInteger(amount) || amount <= 0` thì `throw`), rồi mới cộng.
3. Sau khi cộng vào `wallet.balance`, trả `wallet.balance`.

</details>

<details><summary>Bài 6: totalsByType</summary>

1. Bắt đầu với đối tượng rỗng `const totals = {}`.
2. Với mỗi `tx`, khóa là `tx.type`. Đọc giá trị hiện có bằng `totals[tx.type]`.
3. Nếu `totals[tx.type] === undefined` thì gán `0` trước, rồi cộng `tx.amount`.

</details>

<details><summary>Bài 7: average</summary>

1. Test báo `NaN`: có phép tính dính `undefined`.
2. Chỉ số cuối cùng hợp lệ của mảng 3 phần tử là bao nhiêu?
3. Điều kiện vòng lặp `i <= numbers.length` chạy dư một lần; đổi thành `<`.

</details>

<details><summary>Bài 8: addAmounts</summary>

1. Kết quả `'105'` cho thấy hai vế đang được **nối chuỗi**.
2. Đổi từng vế sang số bằng `Number(...)` trước khi cộng.
3. Viết hàm phụ `toAmount(value)`: `Number(value)`, nếu `Number.isNaN(n)` thì `throw new Error(\`invalid amount: ${value}\`)`.

</details>

## Kiểm tra cuối ngày (15 phút, không xem lại sách)

1. `const` và `let` khác nhau thế nào?
2. `5 === '5'` cho kết quả gì, vì sao?
3. Mảng `[10, 20, 30]` có `length` là mấy, phần tử cuối được viết thế nào?
4. Dòng `at withdraw (...:15:11)` trong thông báo lỗi cho bạn biết điều gì?
5. Vì sao `'10' + '5'` là `'105'`, và cách sửa để được `15`?
6. `throw new Error('...')` làm gì với hàm đang chạy?

<details><summary>Đáp án</summary>

1. `const` không cho gán lại biến; `let` cho gán lại. Mặc định dùng `const`.
2. `false`: `===` so cả kiểu, số khác chuỗi.
3. `length` là 3; phần tử cuối là `arr[arr.length - 1]` (hoặc `arr[2]`).
4. Lỗi được ném trong hàm `withdraw`, tại dòng 15, cột 11 của file đó.
5. Cộng hai chuỗi là nối chuỗi. Đổi sang số trước khi cộng: `Number('10') + Number('5')`.
6. Dừng hàm ngay lập tức và báo lỗi cho nơi gọi; nếu không ai bắt lỗi, chương trình dừng.

</details>

## Lỗi thường gặp

| Dấu hiệu | Nguyên nhân thường gặp | Cách xử lý |
| -------- | ---------------------- | ---------- |
| `'pnpm' is not recognized` | Chưa bật corepack, hoặc terminal mở trước khi cài | `corepack enable`, mở lại terminal, hoặc thêm `corepack` đầu lệnh |
| `Cannot find module` | Chạy lệnh sai thư mục | `cd` vào `node-training`; kiểm tra bằng `pwd` (PowerShell) |
| `ReferenceError: x is not defined` | Gõ sai tên biến, hoặc dùng trước khi khai báo | So từng chữ cái với chỗ khai báo (phân biệt hoa/thường) |
| `SyntaxError: Unexpected token` | Thiếu hoặc thừa ngoặc `()`, `{}`, dấu nháy | Nhìn dòng được chỉ và dòng ngay trước đó |
| Test đỏ nhưng "tôi thấy đúng" | Hàm in ra nhưng quên `return` | Test cần giá trị **trả về**, không phải chữ in ra bằng `console.log` |
| Sửa xong test vẫn đỏ | Chưa lưu file (VS Code chấm tròn ở tên tab) | `Ctrl+S` |

## Checklist: tôi đã làm được

- [ ] Chạy một file bằng `node` và nói được ý nghĩa 3 dòng đầu của một thông báo lỗi.
- [ ] Phân biệt được `const` và `let`, ba kiểu `string` / `number` / `boolean`.
- [ ] Viết được hàm có `return` và `if`.
- [ ] Duyệt được mảng bằng `for...of`.
- [ ] Đọc / ghi được thuộc tính của đối tượng và biết dùng `throw new Error`.
- [ ] Ít nhất 6/8 bài tập xanh (ghi số bài xanh: ___ / 8).

## Câu hỏi còn mở

- Các lệnh `corepack enable`, `code .` và PowerShell **[CHƯA CHẠY]** trên Windows. Nếu khác với sách, ghi lại để điều chỉnh.
- Ghi tại đây những chỗ bạn chưa hiểu để hỏi vào đầu Ngày 2.
