# Ngày 4: Dữ liệu, tiền, ledger sổ kép và idempotency

Khung 4 giờ: Chuẩn bị 20' · Lý thuyết 60' · Đọc code 80' · Thực hành 50' · Thử thách 15' · Kiểm tra 15'.
Ngày này mở đầu nhóm ưu tiên **tiền/ledger/idempotency**. Đây là ngày nặng nhất: đọc kỹ `PayOrder`.

## Mục tiêu hôm nay
- Giải thích sổ kép (double-entry) trong wallet và các luật cân bằng của `LedgerTransaction`.
- Đọc hết `PayOrder` và nêu **bốn lớp chống trùng** của nó.
- Hiểu `TenantUnitOfWork`: transaction, schema theo tenant, Kysely so với EF Core.
- Biết ba bẫy SQL Server trong repo: `datetime2`, `bigint` dạng chuỗi, khóa hàng (`updlock`, `readpast`).

## Chuẩn bị
`git switch -c hoc/ngay-4`. Docker Desktop đang chạy nếu muốn làm Thực hành 3.

## Lý thuyết

### 1. Sổ kép
Mỗi giao dịch ghi **ít nhất hai dòng** (entry) có tổng bằng 0. Ví dụ trả order: ví `−amount`, tài khoản MERCHANT `+amount` (`ledger-transaction.ts:97`); nạp tiền: ví `+amount`, GATEWAY `−amount` (`ledger-transaction.ts:73`). Luật được ép trong `LedgerTransaction.create` (`ledger-transaction.ts:25-71`):
- ≥ 2 dòng; cùng một đồng tiền; không dòng nào bằng 0; một tài khoản không xuất hiện hai lần; **tổng phải bằng 0**; `businessKey` dài 1..200.
- `businessKey` có ràng buộc UNIQUE ở DB (`migrations/001-ledger.ts:31-34`, `uq_ledger_transactions_business_key`): `topup:<topupId>`, `order:<orderId>` (`ledger-transaction.ts:111`), `reversal:<id>` (`ledger-transaction.ts:155`). **Đây là chống trùng tầng cuối**: ghi hai lần cùng nghiệp vụ → DB từ chối.

Luật số dư theo loại tài khoản (`account.ts:52-`): WALLET không âm (ném `InsufficientFundsError`); GATEWAY không dương; MERCHANT không âm. [Phần ADJUSTMENT chưa đọc]

### 2. Tiền
`Money` = số nguyên minor unit + currency (Ngày 1). Quy tắc repo: không dùng `number` thô cho tiền ngoài ranh giới (`docs/architecture/README.md`, "Tiền").

### 3. Kysely và Unit of Work
- **Kysely** là query builder type-safe (không có change tracking như EF Core `DbContext`). Truy vấn thô dùng thẻ `sql\`...\`` (ví dụ `account.repository.ts:41-45`). [GIẢ THUYẾT: mức độ tương đương EF Core chỉ ở khái niệm "truy vấn có kiểu"; không có migration tự sinh từ model — xem migration viết tay ở `migrations/001-ledger.ts`.]
- `KyselyTenantUnitOfWork.run(tenant, work)` (`unit-of-work.ts:22-40`): mở **một transaction SQL**, gắn `withSchema('t_<tenant>')`, và trao cho `work` đủ repository. Rời `work` bình thường → commit; ném lỗi → rollback. Gần `using var tx = db.Database.BeginTransaction()` + `DbContext` theo scope.
- `assertSchemaName` (`schema-name.ts:11-12`) chặn tên schema lạ vì tên schema được ghép vào SQL.

### 4. Bẫy SQL Server (đã kiểm chứng bởi đội, `docs/architecture/README.md`, "Truy cập SQL Server")
- `Date` truyền thẳng làm mất mili-giây → dùng `dateTime(date)` (`packages/database/src/datetime.ts`, cast sang `datetime2(3)`).
- `bigint` trả về chuỗi → đọc qua `toSafeInteger` (`packages/database/src/numbers.ts:5-22`): chuỗi số hợp lệ, trong phạm vi an toàn, nếu không ném `RangeError`.
- Khóa hàng cho worker: `with (updlock, readpast, rowlock)` + index khớp `ORDER BY` (`outbox.repository.ts:21-27`).
- Vi phạm UNIQUE: `isUniqueViolation` nhận mã 2627/2601 (`packages/database/src/errors.ts`); repository dịch thành `DuplicateKeyError` (`ledger.repository.ts:31-35`, `inbox.repository.ts:18-19`).
- Thứ tự khóa tài khoản tăng dần để tránh deadlock (`account.repository.ts:36-40`, `pay-order.ts:127`).

## Đọc code có hướng dẫn
1. `packages/money/src/money.ts` (nhắc lại) và `ledger-transaction.ts:25-71`.
2. **`services/wallet/src/application/pay-order.ts` (179 dòng) — đọc từng khối**:
   - dòng 53-67 `execute`: chạy `uow.run`; bắt `DuplicateKeyError`; `source === 'inbox'` → trả `DUPLICATE`; lỗi trùng khác thì **thử lại đúng 1 lần** (`attempt >= 1` ném tiếp), vì bên thua cuộc đua sẽ thấy khoản trả của bên thắng.
   - dòng 83 `inbox.record(CONSUMER, eventId, now)`: **lớp 1** — khử trùng theo `eventId`.
   - dòng 87-118: nếu `orderPayments.find(orderId)` đã có → **lớp 2** (theo `orderId`): cùng chi tiết thì `REPLAYED` (phát lại `OrderPaidV1` với `walletTransactionId` cũ, không trừ tiền lần nữa); khác chi tiết → `reject('CONFLICT')`; đã bị đảo (`ledger.findReversalOf`) → `CONFLICT`.
   - dòng 120-136: kiểm tra ví tồn tại, cùng đồng tiền, khóa `lockMany([walletId, merchantId])`, ví đóng băng → `WALLET_FROZEN`.
   - dòng 138-146: `lockedWallet.apply(money.negate())`; thiếu tiền → `INSUFFICIENT_FUNDS`.
   - dòng 149-176: `ledger.post` (**lớp 3**: UNIQUE `business_key`), `orderPayments.insert` (khóa theo order), `outbox.add(orderPaidMessage)`.
   - Toàn bộ chạy **trong một transaction**; nhánh từ chối vẫn commit inbox + outbox (`pay-order.ts:45-46` comment).
3. `services/wallet/src/infrastructure/kysely/ledger.repository.ts:18-35` (`post`) và `inbox.repository.ts` (dịch lỗi UNIQUE).
4. `services/wallet/src/infrastructure/kysely/migrations/001-ledger.ts` và `003-orders.ts`: mở bằng editor, tìm ràng buộc UNIQUE/index. [chưa đọc 003]
5. `docs/adr/0002-wallet-ledger-double-entry.vi.md`, `docs/adr/0007-topup-hybrid-submit-and-layered-dedup.vi.md` [tác giả chưa đọc hai ADR này; đọc như tài liệu tham chiếu].

## Thực hành
1. Chạy test miền (không cần Docker): `corepack pnpm vitest run services/wallet/src/domain` (gồm `ledger-transaction.test.ts`, `account.test.ts`). [ĐÃ CHẠY] 7 file, 106 test pass.
2. **Sửa code — thêm luật**: trong `LedgerTransaction.create` thêm giới hạn tối đa 10 entry (ném `InvalidLedgerTransactionError('too many entries')`), viết test trong `ledger-transaction.test.ts` cho cả hai nhánh. Chạy test, `typecheck`, `lint`. *Lưu ý*: kiểm tra xem luật này có phá một nghiệp vụ hiện có không bằng cách chạy lại `corepack pnpm test`.
3. [CHƯA CHẠY: cần Docker] Chạy integration test `PayOrder`: `corepack pnpm test:integration pay-order`. Mở `pay-order.integration.test.ts` và tìm test cho các nhánh `PAID`, `REPLAYED`, `DUPLICATE`, `REJECTED`; đọc tên test để đối chiếu với bốn lớp chống trùng.
4. **Truy vết**: lấy một order giả định (`orderId = o-1`) và liệt kê trên giấy các bản ghi được tạo ra: dòng inbox, hai dòng `ledger_entries`, một `ledger_transactions` (`business_key = order:o-1`), một `order_payments`, một `outbox`.

## Thử thách troubleshoot (nhóm tiền/ledger/idempotency)
**Tình huống A**: ecommerce publish `OrderReadyForPaymentV1` hai lần, `eventId` khác nhau, cùng `orderId`. Khách có bị trừ tiền hai lần không?
*Đáp án*: không. Message thứ hai vượt inbox (eventId mới) nhưng gặp `orderPayments.find(orderId)` đã có → `REPLAYED`, phát lại `OrderPaidV1` cùng `walletTransactionId` (`pay-order.ts:87-117`). Kịch bản chaos S2b kiểm chứng điều này (`tests/chaos/scenarios-sql-broker.chaos.test.ts:358`).

**Tình huống B**: hai consumer xử lý cùng `orderId` đồng thời (đua). Chuyện gì xảy ra?
*Đáp án*: bên thua vi phạm UNIQUE của sổ cái hoặc `order_payments` → rollback; `execute` chạy lại một lần và thấy khoản trả của bên thắng → phát lại (`pay-order.ts:62-64` comment).

**Tình huống C**: tổng số dư theo đồng tiền khác 0. Bạn kiểm tra ở đâu trước?
*Gợi ý*: bất biến INV-1 (`docs/ops/chaos-testing.vi.md`) — mã `TOTAL_NONZERO`, `BALANCE_DRIFT`, `TX_UNBALANCED`, `TX_EMPTY`; oracle ở `tests/chaos/support/invariants.ts`. Đọc runbook đối soát `docs/integration/reconciliation-runbook.vi.md` mục "Loại lệch: ý nghĩa và việc cần làm". [GIẢ THUYẾT: quy trình xử lý thực tế cần đội vận hành xác nhận]

## Kiểm tra cuối ngày
1. Một `LedgerTransaction` hợp lệ cần những điều kiện nào?
2. Kể tên bốn tầng chống trùng khi trả một order.
3. Vì sao `lockMany` sắp xếp id trước khi khóa?
4. Vì sao nhánh từ chối của `PayOrder` vẫn commit transaction?
5. `bigint` từ SQL Server về Node có kiểu gì, và repo xử lý ra sao?
6. Vì sao truyền `Date` trực tiếp cho tedious là rủi ro?
7. `DuplicateKeyError.source === 'inbox'` được xử lý khác lỗi trùng khác thế nào?

### Đáp án
1. ≥2 dòng, cùng đồng tiền, không dòng 0, không trùng tài khoản, tổng 0, businessKey 1..200 (`ledger-transaction.ts:33-62`).
2. (1) inbox theo `eventId` (`pay-order.ts:83`), (2) `order_payments` theo `orderId` (`:87`), (3) UNIQUE `business_key` ở sổ cái (`001-ledger.ts:34`), (4) retry một lần khi đua (`:54-66`).
3. Cố định thứ tự khóa để hai giao dịch cùng chạm ví không deadlock (`account.repository.ts:37`, `pay-order.ts:127`).
4. Để lưu inbox (đã xử lý) và outbox (`OrderPaymentFailedV1`) — consumer ack được mà không xử lý lại vô hạn (`pay-order.ts:45-46`).
5. Chuỗi; `toSafeInteger` chuyển có kiểm tra phạm vi (`numbers.ts:5-22`).
6. Mất mili-giây (gửi kiểu DateTime ~3,33 ms); dùng `dateTime()` (`docs/architecture/README.md`).
7. Trả `DUPLICATE` (message đã xử lý), không thử lại (`pay-order.ts:61`).

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Mong EF Core tự track và `SaveChanges`: ở đây mỗi `saveBalance`/`post` là lệnh SQL tường minh trong transaction.
- Dùng `Number(x)` cho `bigint`; dùng `Date` thẳng vào tham số SQL.
- Quên rằng JSON không có `decimal`: tiền đi qua mạng là `{ amount, currency }` số nguyên.

## Câu hỏi còn mở (cho đội dev)
- Quy tắc loại tài khoản `ADJUSTMENT` (`account.ts:75-`) và vai trò của GATEWAY/MERCHANT trong báo cáo kế toán: cần đội dev giải thích.
- Mức cô lập (isolation level) của transaction SQL Server đang dùng là gì? Tác giả **chưa tìm thấy** cấu hình tường minh trong các file đã đọc.
