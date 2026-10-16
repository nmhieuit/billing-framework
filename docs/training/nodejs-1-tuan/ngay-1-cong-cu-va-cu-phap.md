# Ngày 1: Công cụ, hệ sinh thái và cú pháp JS/TS nền tảng

Khung 4 giờ: Chuẩn bị 30' · Lý thuyết 80' · Đọc code 50' · Thực hành 60' · Thử thách 20' · Kiểm tra 20'.

## Mục tiêu hôm nay
- Chạy được `install`, `typecheck`, `lint`, `test` trên máy Windows.
- Hiểu vai trò của Node, pnpm, TypeScript, `tsx`, vitest, eslint trong repo này và đối chiếu với toolchain .NET.
- Đọc được cú pháp TS cơ bản (type, interface, class, `import/export`, destructuring, arrow function) qua `Money`.
- Chỉ ra được `Money` bất biến và vì sao tiền dùng số nguyên.

## Chuẩn bị
1. Cài Node 22 (repo ghim `.nvmrc` = `22`), Git, VS Code, Docker Desktop.
2. Trong PowerShell tại thư mục repo:
   ```powershell
   corepack pnpm install
   corepack pnpm typecheck
   corepack pnpm lint
   corepack pnpm test
   ```
   [ĐÃ CHẠY] trên Linux: 99 file, 1034 test pass. Nếu `corepack enable` báo lỗi quyền, bỏ qua và cứ gọi `corepack pnpm` (README repo).
3. Tạo nhánh học: `git switch -c hoc/ngay-1`.

## Lý thuyết

### 1. Node.js là gì so với .NET
- **Node** = runtime chạy JavaScript trên engine V8, **một luồng chính** chạy code của bạn. Khác ASP.NET Core có thread pool chạy request song song, Node xử lý nhiều việc nhờ I/O không chặn (Ngày 2).
- **TypeScript (TS)** = JavaScript + hệ thống kiểu tĩnh, được **biên dịch/xóa kiểu** trước khi chạy. Kiểu **không tồn tại ở runtime** (khác C#): kiểm tra kiểu chỉ xảy ra ở `tsc`/IDE.
- Repo chạy TS trực tiếp bằng **`tsx`** (xem script `dev`, `start` ở `services/wallet/package.json`), không có bước build ra `dll`. Việc kiểm tra kiểu là lệnh riêng: `corepack pnpm typecheck` = `tsc --noEmit` (`package.json`).

### 2. Bản đồ toolchain

| Việc | .NET | Repo này | Bằng chứng |
| ---- | ---- | -------- | ---------- |
| Quản lý package | NuGet | pnpm (ghim 9.15.9, qua corepack) | `package.json` (`packageManager`) |
| Nhiều project | solution | pnpm workspace | `pnpm-workspace.yaml`: `services/*`, `packages/*` |
| Tham chiếu project nội bộ | ProjectReference | `"@billing/money": "workspace:^"` | `services/wallet/package.json` |
| Biên dịch/kiểm tra kiểu | `dotnet build` | `tsc --noEmit` | `package.json` script `typecheck` |
| Chạy | `dotnet run` | `tsx src/main.ts` | `services/wallet/package.json` |
| Test | xUnit | vitest | `vitest.config.ts` |
| Phân tích tĩnh | analyzers | eslint + typescript-eslint | `eslint.config.js` |

### 3. Module hệ ESM
`package.json` có `"type": "module"` → file `.ts` dùng `import/export` kiểu ESM. Hai điểm lạ với người .NET:
- Import nội bộ **phải ghi đuôi `.js`** dù file nguồn là `.ts` (ví dụ `import { startService } from './bootstrap.js'`, `services/wallet/src/main.ts:5`). Lý do: `tsconfig.base.json` đặt `module: NodeNext`; TS giữ nguyên đường dẫn như Node sẽ resolve lúc chạy. [GIẢ THUYẾT: lý do chính xác nên hỏi đội dev; hành vi thì thấy rõ trong code]
- **Top-level `await`** dùng được trong module ESM (`services/wallet/src/main.ts:25`: `const service = await startOrExit(...)`).

### 4. Cú pháp tối thiểu (đọc qua `packages/money/src/money.ts`)

| Cú pháp | Ví dụ trong code | Tương đương C# gần đúng |
| ------- | ---------------- | ----------------------- |
| `type X = 'VND' \| 'USD'` (union literal) | `money.ts:3` | gần enum nhưng là kiểu chuỗi |
| `const`, `let` | `money.ts:4` | `readonly` biến cục bộ / biến thường |
| `class` + `private constructor` | `money.ts:6-10` | class với ctor private |
| tham số constructor `readonly amount: number` | `money.ts:8` | primary ctor + thuộc tính |
| `static of(...)` | `money.ts:12` | factory method tĩnh |
| `x ?? y`, `x?.y` | `lifecycle.ts:17` (`??=`) | `??`, `?.` |
| destructuring `const { amount, currency } = value` | `money.ts:30` | deconstruct |
| `unknown` + thu hẹp kiểu (`typeof`) | `money.ts:27-33` | tương tự `object` rồi pattern matching |
| `interface` | `lifecycle.ts:20` | interface (nhưng cấu trúc, không cần khai báo implement) |
| `Promise<T>`, `async/await` | `lifecycle.ts:2` | `Task<T>` |
| arrow function `(a) => a + 1` | `lifecycle.ts:17` | lambda |

Điểm khác cần nhớ:
- **Kiểu cấu trúc** (structural typing): một object thỏa hình dạng interface là đủ, không cần `implements`.
- `number` là số thực 64-bit; không có `int/long/decimal`. Số nguyên chính xác đến `Number.MAX_SAFE_INTEGER` (~9×10^15). Vì vậy `Money.of` bắt `Number.isSafeInteger` (`money.ts:13`) và tiền lưu bằng **minor unit** (đơn vị nhỏ nhất, số nguyên).
- `===` so sánh nghiêm ngặt (không ép kiểu); không dùng `==`.
- `null` và `undefined` là hai giá trị khác nhau; code dùng cả hai (`CustomerId | null` ở `pay-order.ts:35`).

## Đọc code có hướng dẫn
1. `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` được bật. *Hỏi*: bật `strict` ảnh hưởng gì khi truy cập phần tử mảng (`arr[0]` có kiểu gì)?
2. `vitest.config.ts`: file nào bị loại khỏi `pnpm test`? (gợi ý: `*.integration.test.ts`, `*.chaos.test.ts`, `*.soak.test.ts`, `*.perf.test.ts`).
3. `packages/money/src/money.ts` (83 dòng) và `money.test.ts`. *Hỏi*: `Money.of(-0, 'VND')` trả gì? (xem `money.ts:19` và test "normalises negative zero").
4. `eslint.config.js`: tìm danh sách `FRAMEWORKS` (dòng 6-17) và `LAYERS` (dòng 4): đây là cơ sở của Ngày 3.

## Thực hành
1. Chạy riêng một nhóm test: `corepack pnpm vitest run packages/money` → 20 test pass [ĐÃ CHẠY].
2. **Sửa code**: trong `money.ts` thêm phương thức
   ```ts
   multiply(factor: number): Money {
     return Money.of(this.amount * factor, this.currency);
   }
   ```
   Viết test trong `money.test.ts`: `Money.of(100,'VND').multiply(3).amount` bằng `300`, và `multiply(0.5)` ném `InvalidMoneyError` khi kết quả không nguyên (ví dụ `Money.of(101,'VND').multiply(0.5)`).
   Chạy lại test + `corepack pnpm typecheck` + `corepack pnpm lint`.
3. Cố ý gây lỗi kiểu, hai trường hợp [ĐÃ CHẠY]. Tạo tạm `packages/money/src/tmp-probe.test.ts` (xóa sau khi xong):
   ```ts
   import { expect, it } from 'vitest';
   import { Money } from './index.js';
   it('chuỗi thay vì số', () => {
     expect(Money.of('5', 'USD').amount).toBe(5);
   });
   it('object thường thay vì Money', () => {
     expect(Money.of(100, 'VND').equals({ amount: 100, currency: 'VND' })).toBe(true);
   });
   ```
   - `corepack pnpm typecheck` báo **cả hai** dòng: `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'` và `... is not assignable to parameter of type 'Money'`.
   - `corepack pnpm vitest run packages/money/src/tmp-probe`: test 1 **fail lúc chạy** với `InvalidMoneyError: amount must be a safe integer` (vì `Number.isSafeInteger('5')` là false, `money.ts:13`), test 2 **pass** (code chạy chỉ đọc `amount`/`currency`, không biết kiểu sai).
   - Bài học: kiểu bị xóa lúc chạy; lỗi có thể được runtime bắt (test 1, nhờ code phòng thủ) hoặc lọt qua (test 2). Chỉ `typecheck` bắt được cả hai.
4. Chạy `corepack pnpm format:check` và đọc kết quả (prettier).

## Thử thách troubleshoot
**Triệu chứng**: sau khi sửa, `vitest` pass nhưng `typecheck` đỏ. Câu hỏi: lệnh nào là cổng chặn lỗi kiểu, và CI có chạy nó không? Mở `Jenkinsfile` tìm các stage.
*Gợi ý*: stage "Static checks" (`Jenkinsfile:38-42`).
*Đáp án*: stage "Static checks" chạy `lint`, `typecheck`, `format:check`; sau đó "Test" chạy `test:coverage`, "Integration tests" chạy `test:integration` (`Jenkinsfile:31-55`). Vitest không kiểm tra kiểu, nên chỉ `typecheck` chặn được lỗi này.

## Kiểm tra cuối ngày
1. Vì sao `Money.amount` là số nguyên chứ không phải `number` thập phân?
2. Kiểu TS có tồn tại lúc chạy không? Hệ quả khi dữ liệu JSON từ ngoài vào?
3. `corepack pnpm test` khác `corepack pnpm test:integration` thế nào?
4. Import nội bộ phải có đuôi `.js`: ví dụ một dòng trong repo.
5. `workspace:^` nghĩa là gì và tương đương gì bên .NET?
6. `Money.fromJSON` tồn tại để làm gì (xem phần nhận dữ liệu `unknown`)?

### Đáp án
1. `money.ts:13-15`: yêu cầu `Number.isSafeInteger`; tiền lưu theo minor unit, tránh sai số dấu phẩy động. `docs/architecture/README.md` mục "Tiền".
2. Không. Dữ liệu JSON từ ngoài vào phải được kiểm tra lúc chạy, như `Money.fromJSON` (`money.ts:26-35`) và `@billing/contracts` (Ngày 5).
3. `vitest.config.ts` loại `*.integration.test.ts`; integration cần Docker (`docs/architecture/README.md` mục "Kiểm thử").
4. `services/wallet/src/main.ts:5`.
5. Tham chiếu package nội bộ trong workspace; gần `ProjectReference`.
6. Biến `unknown` (không tin kiểu) thành `Money` hợp lệ hoặc ném `InvalidMoneyError`.

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Tưởng `number` có `int/long`; tiền dùng `number` thô sẽ sai (repo cấm ngoài ranh giới: `docs/architecture/README.md` mục "Tiền").
- Quên rằng kiểu bị xóa lúc chạy.
- Quên đuôi `.js` khi import.

## Câu hỏi còn mở (cho đội dev)
- Production chạy service bằng gì? `deploy/Dockerfile.dev` ghi rõ chỉ cho local ("Không dùng cho production", dòng 1) và chạy bằng `tsx`. Repo không có Dockerfile production mà tác giả thấy; cần đội dev xác nhận cách đóng gói production.
