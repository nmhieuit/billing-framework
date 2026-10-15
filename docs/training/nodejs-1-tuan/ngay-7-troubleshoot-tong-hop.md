# Ngày 7: Troubleshoot tổng hợp và kiểm tra cuối tuần

Khung 4 giờ: Ôn + chuẩn bị 30' · Lý thuyết (chaos, retention, ops, đối soát) 50' · Đọc code 40' · Thực hành 50' · Tình huống tổng hợp 50' · Kiểm tra cuối tuần 20'.
Docker Desktop cần cho phần chaos và integration. Các bước đó là [CHƯA CHẠY] ở môi trường biên soạn.

## Mục tiêu hôm nay
- Dùng **8 bất biến về tiền** (INV-1..8) như bộ khung chẩn đoán.
- Chạy được một kịch bản chaos và đọc kết quả.
- Hiểu retention (chạy thử → xóa thật), ops tools (có kiểm toán) và đối soát (loại lệch).
- Tự chẩn đoán ≥ 3 tình huống: **tiền/ledger**, **messaging**, **vận hành** (tiêu chí hoàn thành của lộ trình).

## Chuẩn bị
`git switch -c hoc/ngay-7`. Đọc lại phần kiểm tra cuối ngày của Ngày 4 và Ngày 5.

## Lý thuyết

### 1. Tám bất biến (nguồn: `docs/ops/chaos-testing.vi.md`, mục "Các cam kết được kiểm tra")
| Mã | Cam kết | Mã vi phạm tiêu biểu |
| -- | ------- | -------------------- |
| INV-1 | Sổ cái cân bằng, số dư khớp tổng dòng | `TOTAL_NONZERO`, `BALANCE_DRIFT`, `TX_UNBALANCED`, `TX_EMPTY` |
| INV-2 | Mỗi order chỉ bị ghi nợ một lần | `ORPHAN_ORDER_TX`, `ORDER_PAYMENT_AMOUNT_MISMATCH`, `RECEIVED_PAID_MISMATCH` |
| INV-3 | Nạp tiền khớp giữa wallet và payment | `TOPUP_TX_MISSING`, `CHARGE_TOPUP_NOT_SUCCEEDED`, `SUM_MISMATCH`, `DUPLICATE_CHARGE_REF` |
| INV-4 | Outbox ít nhất một lần | `OUTBOX_NOT_SENT`, `SENT_NOT_RECEIVED`, `PAID_NOT_RECEIVED`, `OUTBOX_PAID_UNKNOWN_ORDER` |
| INV-5 | Đối soát hội tụ | `RECONCILIATION_RUN_FAILED`, `MISSING_AT_WALLET_UNFIXED`, `AUTOFIX_UNEXPECTED`, `RECONCILIATION_NOT_CONVERGED` |
| INV-6 | Thao tác ops nguyên tử | `ADJUST_TX_MISSING`, `REVERSE_ACTION_DUPLICATE`, `FREEZE_STATE_MISMATCH`, `REPLAY_OUTBOX_MISSING` |
| INV-7 | Thứ đã xác nhận cho client vẫn còn (kể cả sau retention thật) | `ACKED_ORDER_MISSING`, `ACKED_TOPUP_MISSING`, `ACKED_OPS_ACTION_MISSING` |
| INV-8 | Phục hồi: `GET /health` = 200 và đọc được DB | `HEALTH_FAILED`, `READ_FAILED`, `SERVICE_DOWN` |
Oracle: `tests/chaos/support/invariants.ts` chạy theo thứ tự cố định vì đối soát có **ghi bù** và có thể che lỗi (INV-1/2/4 chặt → INV-3 trước đối soát → INV-8 → INV-5 → INV-6/7). Có test riêng cho oracle: `tests/chaos/invariants.chaos.test.ts`.

### 2. Chaos test
- Cố ý làm hỏng SQL Server (`KILL` session), RabbitMQ (rớt kết nối, publish trùng/mất), HTTP wallet↔payment, và chính service (`SIGKILL`), rồi chạy oracle (`README repo`, mục "Chaos test").
- Chạy bằng **testcontainers**, không dùng stack `billing-local`: `corepack pnpm test:chaos`; lọc **không dùng `--`**:
  ```powershell
  corepack pnpm test:chaos scenarios-sql-broker            # S1-S5
  corepack pnpm test:chaos scenarios-payment-crash -t S9   # một kịch bản
  ```
- Seed: `CHAOS_SEED` (PowerShell: `$env:CHAOS_SEED=123; corepack pnpm test:chaos:soak`). Kịch bản S1-S13 không dựa vào seed. Log lỗi ở `tests/chaos/.out/`.
- Thời gian: khoảng 11–12 phút cho `test:chaos` trên máy Windows của đội (`chaos-testing.vi.md`, mục "Thời gian điển hình"); với bạn có thể khác.

### 3. Retention (`docs/ops/retention.vi.md`)
- Job nền xóa dữ liệu hết giá trị; **không bao giờ chạm sổ cái, `accounts`, `topups`, `order_payments`, `charges`** (mục "Luật an toàn").
- Mặc định `RETENTION_ENABLED=true` và `RETENTION_DRY_RUN=true`: **chỉ đếm**. Quy trình: chạy thử nhiều lượt → so với kỳ vọng → **sao lưu DB** → đặt `RETENTION_DRY_RUN=false` và khởi động lại từng service (mục "Từ chạy thử sang xóa thật").
- Số ngày mặc định/tối thiểu theo bảng (ví dụ outbox `SENT` 14 ngày, `processed_messages` 30 ngày, `idempotency_keys` 90 ngày).

### 4. Ops tools (`docs/ops/ops-tools.vi.md`)
- Nhóm API `/ops/...`: đóng/mở băng ví, điều chỉnh số dư, đảo giao dịch, phát lại `OrderPaidV1`. Bắt buộc `reason` và `idempotencyKey`; chạy cùng transaction với một dòng nhật ký `ops_actions` chỉ thêm (README repo, mục "Công cụ vận hành").
- Danh tính từ header `x-actor-id`, `x-actor-role: OPS`, `x-tenant-id`; **gateway phải xóa `x-actor-*` do client gửi**. Chỉ dành cho mạng vận hành.
- Quy trình "khách báo nhầm tiền": freeze → điều tra → adjust/reverse → unfreeze.

### 5. Đối soát (`docs/integration/reconciliation-runbook.vi.md`)
Bảng loại lệch: `MISSING_AT_WALLET`, `UNKNOWN_CHARGE`, `MISSING_AT_GATEWAY`, `AMOUNT_MISMATCH`/`STATUS_MISMATCH`, `LEDGER_UNBALANCED`/`BALANCE_MISMATCH` (**mức cao nhất**: dừng thay đổi ví của tenant và báo kỹ thuật).

## Đọc code có hướng dẫn
1. `tests/chaos/scenarios-sql-broker.chaos.test.ts`: đọc tên các `it` S1..S5 (dòng 134, 192, 258, 286, 318, 358, 385, 421). Chọn **S2** (dòng 192) và đọc từ đầu đến cuối.
2. `tests/chaos/support/invariants.ts` — phần chú thích đầu file (danh sách mã).
3. `services/wallet/src/application/retention.ts` và `packages/runtime/src/drain.ts` (`drainBatches`, Ngày 2).
4. `services/wallet/src/interface/http/ops.controller.ts` và `ops.guard.ts`; `application/ops-recorder.ts`.
5. `docs/ops/chaos-findings.vi.md`: lỗi thật chaos đã tìm ra. [tác giả chưa đọc; đọc như bài tổng kết]
6. `docs/adr/0010`, `0012`, `0013`, `0014` (đối soát, retention, ops tools, chaos). [tác giả chưa đọc]

## Thực hành
1. [ĐÃ CHẠY] Toàn bộ test miền và unit: `corepack pnpm test` (99 file, 1034 test pass trong môi trường biên soạn).
2. [CHƯA CHẠY] `corepack pnpm test:chaos scenarios-sql-broker -t S2` — đọc log, xác định bất biến nào được oracle kiểm sau kịch bản.
3. **Sửa code để oracle bắt lỗi** [CHƯA CHẠY, cần Docker]: trong `pay-order.ts` tạm thời comment dòng ghi `orderPayments.insert` (dòng 161-168) hoặc làm `ledger.post` chạy hai lần, rồi chạy `corepack pnpm test:integration pay-order` và một kịch bản S2. Ghi lại test nào đỏ và bất biến nào bị vi phạm. Hoàn tác bằng `git restore`.
4. Viết bảng "triệu chứng → bất biến → tài liệu" cho 6 triệu chứng bất kỳ ở mục Tình huống bên dưới.

## Tình huống tổng hợp (tự làm trước, đáp án ở cuối)

**T1 (tiền/ledger).** Báo cáo cuối ngày: tổng số dư mọi tài khoản của tenant `acme` bằng VND khác 0. (a) Bất biến nào bị vi phạm? (b) Làm gì trước tiên? (c) Có nên chạy `adjustments` ngay không?
**T2 (tiền/idempotency).** Khách khiếu nại bị trừ tiền hai lần cho order `o-1`. Bạn kiểm tra gì?
**T3 (messaging).** `billing-dlq-not-empty` đang bắn; header `x-dead-letter-reason` = `retries exhausted: handler threw: ...`. Hạ tầng đã khỏe lại. Làm gì?
**T4 (messaging).** Orders báo "order còn Unpaid dù ví đã bị trừ". Làm gì?
**T5 (vận hành).** Bạn muốn bật `RETENTION_DRY_RUN=false` ở production. Các điều kiện tiên quyết?
**T6 (vận hành).** Một nhân viên gọi `POST /ops/...` nhận `403 FORBIDDEN_ROLE`. Nguyên nhân?
**T7 (đối soát).** Kết quả đối soát có ca `MISSING_AT_GATEWAY` với `topupCompletedAt` cách `topupCreatedAt` 2 ngày. Có nghi ghi sổ sai không?

## Kiểm tra cuối tuần (20 câu — ngắn, tự chấm bằng đáp án bên dưới)
1. Kiểu TS có tồn tại lúc chạy không? (Ngày 1)
2. Thứ tự in của lab event-loop và lý do. (Ngày 2)
3. Vì sao `Worker` không chồng hai tick? (Ngày 2)
4. Thứ tự tắt của wallet và vì sao DB đóng cuối? (Ngày 2)
5. Ranh giới `domain → application → infrastructure/interface` ép bằng gì? (Ngày 3)
6. Vì sao `@Inject(TOKEN)` tường minh? (Ngày 3)
7. Một giao dịch sổ cái hợp lệ cần gì? (Ngày 4)
8. Bốn tầng chống trùng của `PayOrder`? (Ngày 4)
9. Vì sao khóa tài khoản theo thứ tự id? (Ngày 4)
10. Hai bẫy SQL Server liên quan thời gian và số lớn? (Ngày 4)
11. Handler trả `reject` khi nào, `retry` khi nào? (Ngày 5)
12. Message qua 5 bậc retry đi đâu? (Ngày 5)
13. Vì sao `RelayOutbox` publish ngoài transaction? (Ngày 5)
14. Vì sao có thể trùng `OrderPaidV1`? (Ngày 5)
15. `correlationId` vào log bằng cơ chế nào và chỗ nào chưa có? (Ngày 6)
16. Telemetry không cấu hình thì sao? (Ngày 6)
17. Kể tên INV-1..INV-8 bằng lời. (Ngày 7)
18. Retention chạy thử khác xóa thật thế nào, bảng nào không bao giờ bị xóa? (Ngày 7)
19. Ops tool cần header nào và gateway phải làm gì? (Ngày 7)
20. `LEDGER_UNBALANCED` xử lý ra sao? (Ngày 7)

## Đáp án

### Tình huống
- **T1.** (a) INV-1 (`TOTAL_NONZERO`, có thể kèm `BALANCE_DRIFT`/`TX_UNBALANCED`). (b) Theo runbook đối soát: `LEDGER_UNBALANCED`/`BALANCE_MISMATCH` là **mức cao nhất**: dừng thay đổi ví của tenant, báo kỹ thuật ngay, tìm log `ledger integrity check failed` (`reconciliation-runbook.vi.md`, bảng loại lệch). (c) Không: `adjustments` che lỗi toàn vẹn; điều tra nguyên nhân trước. [GIẢ THUYẾT: quy trình sửa dữ liệu cuối cùng cần đội dev/kế toán quyết định.]
- **T2.** Tìm `ledger_transactions` có `business_key = order:o-1` (UNIQUE nên chỉ có tối đa 1: `001-ledger.ts:34`, `ledger-transaction.ts:111`) và `order_payments` của `o-1`. Nếu chỉ có một giao dịch: khiếu nại có thể do `OrderPaidV1` phát lại (`REPLAYED`, `pay-order.ts:109-117`) chứ không phải trừ hai lần; nếu có nhiều dòng nghĩa là INV-2 bị vi phạm → leo thang. Kiểm tra cả khoản đảo (`ledger.findReversalOf`, `pay-order.ts:102`).
- **T3.** Theo runbook DLQ: xem message ở chế độ requeue, xác nhận nguyên nhân đã hết, **rồi** đưa về `wallet.work` với routing key `order-payments` (3 cách, trong đó cách 1 là RabbitMQ management "Move messages"); vì `PayOrder` idempotent nên an toàn (`dlq-runbook.vi.md`).
- **T4.** `ops-tools.vi.md` mục "Quy trình khuyến nghị": kiểm tra `order_payments` có order đó, rồi `replay-paid`; nếu vẫn không chuyển `Paid`: xem outbox (`billing-outbox-stuck`), queue của Orders gắn vào `billing.events`, và DLQ.
- **T5.** Chạy thử nhiều lượt, so số đếm với kỳ vọng, **sao lưu `billing_wallet` và `billing_payment`**, bật từng service một, theo dõi `billing.retention.last_success_timestamp_seconds` và rule `billing-retention-stalled` (`retention.vi.md`, mục "Từ chạy thử sang xóa thật").
- **T6.** Gateway không đặt `x-actor-role: OPS` (giá trị khác, kể cả `OPS, ADMIN`, bị từ chối) (`ops-tools.vi.md`, bảng header).
- **T7.** Thường là dương tính giả quen thuộc khi `topupCompletedAt` cách `topupCreatedAt` hơn một ngày: charge có thật, đóng ca `IGNORED`; nhưng **trước khi hành động phải tra gateway theo `chargeId`** (`reconciliation-runbook.vi.md`).

### Kiểm tra cuối tuần
1. Không (kiểu bị xóa; `fromJSON`/`validateEvent` kiểm lúc chạy).
2. `A, C, B, D` (đồng bộ → microtask → timer → sau await).
3. `setTimeout(loop)` chỉ đặt sau khi tick trước xong (`worker.ts:38-40`).
4. `broker.stopConsuming` → worker → `app.close` → drain → `broker.close` → `db.destroy` (`bootstrap.ts:314-331`); DB cuối vì các bước trước còn có thể ghi.
5. ESLint `no-restricted-imports` (`eslint.config.js`) và `tools/boundaries.test.ts`.
6. `emitDecoratorMetadata` không được `tsx` phát (`docs/architecture/README.md`).
7. ≥2 dòng, cùng đồng tiền, không dòng 0, không trùng tài khoản, tổng 0 (`ledger-transaction.ts:25-71`).
8. inbox theo `eventId`; `order_payments` theo `orderId`; UNIQUE `business_key`; retry 1 lần khi đua (`pay-order.ts`).
9. Tránh deadlock (`account.repository.ts:37`).
10. Dùng `dateTime()` cho `Date` (mất mili-giây); `bigint` về chuỗi → `toSafeInteger`.
11. `reject`: message hỏng/tenant lạ; `retry`: lỗi hạ tầng (`order-ready.handler.ts`, `consumer.ts:131`).
12. `<queue>.dlq` với lý do `retries exhausted: ...` (`consumer.ts:104`).
13. Không giữ khóa DB khi chờ broker; đổi lại at-least-once (`relay-outbox.ts:22-25`).
14. Outbox at-least-once và `REPLAYED` phát lại; bên nhận khử trùng theo `eventId`.
15. `AsyncLocalStorage` + `pino` mixin; chỉ bọc ở HTTP (wallet middleware, payment `app.ts:32`), consumer chưa thấy (`ngay-6`).
16. No-op.
17. (1) sổ cái cân; (2) order ghi nợ một lần; (3) nạp tiền khớp wallet–payment; (4) outbox at-least-once; (5) đối soát hội tụ; (6) ops nguyên tử; (7) thứ đã xác nhận vẫn còn; (8) phục hồi.
18. Chạy thử chỉ đếm; xóa thật cần `RETENTION_DRY_RUN=false`. Không xóa: `ledger_transactions`, `ledger_entries`, `accounts`, `topups`, `order_payments`, `charges` (và `ops_actions`).
19. `x-actor-id`, `x-actor-role: OPS`, `x-tenant-id`; gateway xóa `x-actor-*` do client gửi.
20. Mức cao nhất: dừng thay đổi ví của tenant, báo kỹ thuật ngay (runbook đối soát).

Chấm điểm: ≥ 16/20 là đạt; tiêu chí cuối tuần: tự chẩn đoán được T1, T3, T5 mà không xem đáp án.

## Lỗi thường gặp khi chuyển từ .NET sang Node
- Sửa dữ liệu thẳng trong DB để "chữa cháy": bỏ qua `ops_actions` nên mất kiểm toán.
- Bật retention thật mà chưa sao lưu.
- Đưa message từ DLQ về khi nguyên nhân chưa hết.

## Câu hỏi còn mở (cho đội dev)
- Quy trình chính thức khi INV-1 vi phạm ở production (ai quyết định bút toán sửa)?
- `docs/ops/chaos-findings.vi.md` có mục nào còn mở cần theo dõi?
- Tác giả chưa chạy được integration/chaos/stack local; hãy ghi lại sai khác khi bạn chạy để cập nhật giáo trình.
