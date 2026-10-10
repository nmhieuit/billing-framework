# Bước 5 — Đối soát: thiết kế

**Ngày:** 2026-10-10
**Trạng thái:** Đã triển khai (xem ADR-0010)
**Phạm vi:** Module `reconciliation` của wallet: kiểm tra toàn vẹn ledger nội bộ và đối soát Wallet ↔ Gateway (payment), lưu kết quả theo run bất biến, tự ghi bù loại lệch an toàn, API xem/đóng ca. Phép kiểm tra Wallet ↔ Orders chỉ được định nghĩa hợp đồng bằng tài liệu. Dựa trên spec nền tảng (`2026-10-09-billing-framework-design.md`, mục 6), wallet core và Bước 4.

## 1. Mục tiêu và quyết định đã chốt

Phát hiện sớm và có bằng chứng khi tiền của wallet không khớp với gateway hoặc với chính sổ cái, và tự sửa duy nhất loại lệch chứng minh được là an toàn (gateway đã xác nhận thu tiền mà wallet chưa ghi).

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Phạm vi | Ledger nội bộ + Wallet↔Gateway làm trọn. Wallet↔Orders chỉ định nghĩa hợp đồng snapshot (tài liệu), chưa chạy |
| 2 | Kích hoạt | Định kỳ trong worker hiện có (ngày D-1 UTC, từng tenant) + API chạy theo yêu cầu. Mỗi lần chạy tạo run mới, bất biến |
| 3 | Tự sửa | Chỉ `MISSING_AT_WALLET`, qua đường nạp bình thường (`ApplyPaymentResult`), chống trùng; cờ `RECONCILE_AUTOFIX` mặc định bật. Mọi loại lệch khác chỉ báo + ca thủ công |
| 4 | Ca thủ công | Lưu item `OPEN`, API xem và đóng ca (`RESOLVED`/`IGNORED`) có ghi chú và người xử lý. Không sửa sổ (bút toán đảo/bù ngoài bước này) |

## 2. Kiến trúc

Module `reconciliation` trong `services/wallet`, 4 lớp hexagonal, tuân các luật ESLint hiện có:

- `domain`: hàm thuần phân loại lệch, tổng kiểm theo đồng tiền, validate ngày/ghi chú. Chỉ import `@billing/money`.
- `application`: use case `RunReconciliation`, `ResolveItem`, `GetRun`/`ListItems`; port `SettlementSource` (đọc settlement theo ngày, cursor) và các port repository.
- `infrastructure`: repository Kysely (run/item), adapter HTTP `SettlementSource` gọi `GET /settlements?date=` của payment, truy vấn kiểm tra ledger.
- `interface`: endpoint HTTP nội bộ (cùng `caller.guard`, tenant theo header) và task `reconcile-daily` trong worker.

Phạm vi mỗi run: một tenant × một ngày UTC; lịch lặp qua `tenantRegistry.all()` (ADR-0006).

## 3. Các phép kiểm tra

### 3.1 Ledger nội bộ

Hai truy vấn tổng hợp trong một transaction chỉ đọc:

- Giao dịch có tổng các dòng khác 0 → `LEDGER_UNBALANCED`.
- Ví có số dư cache khác tổng sổ cái của ví → `BALANCE_MISMATCH`.

Cả hai là lỗi toàn vẹn dữ liệu: log `error`, không tự sửa.

### 3.2 Wallet ↔ Gateway

Lấy toàn bộ settlement của ngày (cursor, 1000/trang), giữ charge có `metadata.tenantId` đúng tenant (charge thiếu hoặc mang `metadata.tenantId` của tenant khác bị bỏ qua trong lượt của tenant này), so với bảng `topups` theo `charge_id` và `reference = topupId`. Settlement chỉ liệt kê charge đã hoàn tất, nên topup còn `PENDING` mà gateway chưa có không phải lệch.

| kind | Điều kiện | Xử lý |
|---|---|---|
| (khớp) | Cùng `chargeId`, số tiền, đồng tiền, trạng thái (`SUCCEEDED`/`FAILED`) | Không item |
| `MISSING_AT_WALLET` | Gateway `SUCCEEDED`, wallet có topup `REQUESTED`/`PENDING`, hoặc `FAILED` với `PAYMENT_UNAVAILABLE` | Tự ghi bù (nếu cờ bật), ngược lại ca thủ công |
| `UNKNOWN_CHARGE` | Gateway có charge, wallet không có topup tương ứng, hoặc topup đã gắn với charge khác | Ca thủ công |
| `MISSING_AT_GATEWAY` | Wallet topup `SUCCEEDED`, gateway không có (so với settlement của ngày D **và** D-1) | Ca thủ công |
| `AMOUNT_MISMATCH` | Khác số tiền hoặc đồng tiền | Ca thủ công |
| `STATUS_MISMATCH` | Khác trạng thái | Ca thủ công |

Tổng kiểm: tổng `SUCCEEDED` ở gateway và tổng `TOPUP` ở wallet, tách theo đồng tiền (VND và USD không cộng lẫn). Các tổng này chỉ để tham khảo (lưu trên run); chỉ phép so từng item mới sinh lệch.

### 3.3 Tự ghi bù

Với mỗi `MISSING_AT_WALLET`, gọi `ApplyPaymentResult` với `eventId = reconcile:<runId>:<chargeId>` và `type = charge.succeeded`. Mỗi lần ghi bù là một transaction riêng; lỗi một item không ảnh hưởng item khác. Kết quả `APPLIED` → item `AUTO_APPLIED` (`detail.autofix = "APPLIED"`); `IGNORED` mà topup đã `SUCCEEDED` (webhook thật đến trước) cũng là `AUTO_APPLIED` (`detail.autofix = "already settled"`). Các kết quả khác (`DUPLICATE`, `MISMATCH`, `UNKNOWN_TOPUP`, lỗi) → `FAILED_AUTOFIX`, ca vẫn `OPEN`. Item `AUTO_APPLIED` được lưu `RESOLVED` bởi `system` với ghi chú `auto-applied by reconciliation`. Event id theo lượt nên lần thử thất bại trước không chặn lượt sau; chống cộng hai lần nhờ business key `topup:<id>`, kể cả khi webhook đến giữa chừng hoặc hai run chạy song song. Nếu run thất bại sau khi đã ghi bù, `failure_reason` nêu các topup đã được ghi bù.

## 4. Luồng chạy và lịch

`RunReconciliation.execute({ tenant, day, triggeredBy })`:

1. Tạo run `RUNNING` (transaction riêng).
2. Kiểm tra ledger nội bộ (3.1).
3. Đọc dữ liệu topup của wallet, rồi gọi HTTP settlement **ngoài transaction** (không giữ transaction qua lời gọi mạng), phân loại (3.2).
4. Tự ghi bù (3.3) nếu cờ bật.
5. Ghi item và tổng kiểm, đóng run `COMPLETED`.

Gateway lỗi/timeout, hoặc vượt `RECONCILE_MAX_ITEMS` → run `FAILED` kèm lý do, không có item nửa vời và không ghi bù gì.

**Lịch:** task `reconcile-daily` trong worker, ngày D-1 UTC cho từng tenant, chỉ chạy sau `RECONCILE_AT_UTC_HOUR`. Mỗi (tenant, ngày) chỉ có tối đa một run `SCHEDULED` không-`FAILED` (unique index lọc). Quy tắc mỗi tick:

- Run `RUNNING` quá 30 phút được coi là worker đã chết và chuyển `FAILED`.
- Run `SCHEDULED` `FAILED` được thử lại tối đa `RECONCILE_MAX_ATTEMPTS` lần, cách nhau ít nhất 15 phút, mỗi lần là run mới. Hết số lần → `GAVE_UP` (log `scheduled reconciliation gave up`), cần sửa nguyên nhân rồi chạy tay.
- `DONE`/`GAVE_UP` được nhớ trong bộ nhớ theo tenant và ngày (trả lại đúng kết quả đã quyết định) để không truy vấn DB mỗi tick; mất khi tiến trình khởi động lại, khi đó DB là nguồn sự thật.
- Hai run cùng ngày cùng lúc (tay + lịch) được phép.

## 5. Mô hình lưu

Migration `004-reconciliation` trong từng schema tenant.

`reconciliation_runs`: `id`, `run_day`, `status` (`RUNNING`|`COMPLETED`|`FAILED`), `triggered_by` (`SCHEDULED`|`MANUAL`), `failure_reason`, `gateway_totals`, `wallet_totals` (theo đồng tiền, JSON), `item_count`, `started_at`, `finished_at`.

`reconciliation_items`: `seq` (identity, dùng làm cursor phân trang), `id`, `run_id`, `kind`, `charge_id`, `topup_id`, `amount_gateway`, `amount_wallet`, `currency`, `detail` (JSON), `action` (`NONE`|`AUTO_APPLIED`|`FAILED_AUTOFIX`), `case_status` (`OPEN`|`RESOLVED`|`IGNORED`), `resolved_by`, `resolution_note`, `resolved_at`, `created_at`.

Unique index lọc: `run_day` với điều kiện `triggered_by = 'SCHEDULED' and status <> 'FAILED'`.

Run bất biến: chạy lại tạo run mới; item cũ chỉ đổi `case_status` và các cột `resolved_*` khi đóng ca.

## 6. API nội bộ

Cùng guard và quy ước tenant/correlation như các endpoint wallet hiện có.

- `POST /reconciliations` `{ "date": "YYYY-MM-DD" }` → `202` + `{ "runId", "status": "RUNNING" }`; chạy nền. Ngày sai định dạng/tương lai → `422`.
- `GET /reconciliations/:runId` → trạng thái và tổng kiểm.
- `GET /reconciliations/:runId/items?caseStatus=&cursor=` → danh sách phân trang.
- `POST /reconciliation-items/:id/resolve` `{ "status": "RESOLVED"|"IGNORED", "note": "1..500 ký tự", "resolvedBy": "1..64 ký tự" }` → `200`. Lặp lại cùng giá trị trả cùng kết quả; giá trị khác → `409`; thiếu `note`/`resolvedBy` hoặc `status` sai → `422`.

## 7. Cấu hình

`RECONCILE_AUTOFIX` (mặc định `true`), `RECONCILE_AT_UTC_HOUR` (mặc định `2`), `RECONCILE_MAX_ATTEMPTS` (mặc định `3`), `RECONCILE_MAX_ITEMS` (mặc định `50000`), cùng `PAYMENT_BASE_URL` và credential hiện có để gọi settlement. Mọi biến vào `.env.example` và được `env-example.test.ts` kiểm.

## 8. Quan sát

Log có `correlationId`: `error` cho `LEDGER_UNBALANCED`/`BALANCE_MISMATCH`, `warn` cho ca thủ công, `info` cho `AUTO_APPLIED`. Chưa có metric/cảnh báo (Bước 6); `reconciliation_runs` lưu đủ số liệu để Bước 6 đọc.

## 9. Kiểm thử

TDD; mỗi loại lệch có kịch bản dựng lệch có chủ đích. Dùng SQL Server testcontainer và `FakePaymentServer` sẵn có.

- **Unit (domain):** phân loại đủ bảng 3.2 (kể cả topup `PENDING` không lệch, `FAILED` khớp `FAILED`); tổng kiểm theo đồng tiền; validate ngày và ghi chú.
- **Integration:** ledger lệch tổng và số dư cache sai (và trường hợp sạch); từng `kind` của 3.2 với `FakePaymentServer`, gồm settlement nhiều trang và lọc theo tenant; tự ghi bù đúng một lần (kể cả hai run song song, webhook đến giữa chừng, cờ tắt); run bất biến khi chạy lại; gateway 500/timeout và vượt `RECONCILE_MAX_ITEMS` → `FAILED`; lịch không tạo run `SCHEDULED` trùng và thử lại tới giới hạn; API (202, 422, guard, resolve idempotent/409/422).
- Không kiểm: hiệu năng hàng triệu dòng; chạy với ecommerce thật.

## 10. Hợp đồng Wallet ↔ Orders (chỉ tài liệu)

`docs/integration/orders-reconciliation.vi.md` và một mục ngắn trong tài liệu bàn giao hiện có:

- **Snapshot ecommerce cần cung cấp:** order `Paid` trong ngày theo tenant, mỗi dòng gồm `orderId`, `customerId`, `amount`, `currency`, `paidAtUtc`, `walletTransactionId`. Hình thức (endpoint phân trang cursor hoặc file theo ngày) chốt cùng team ecommerce.
- **Quy tắc đối chiếu khi có snapshot:** mỗi `ORDER_PAYMENT` phải có order `Paid` khớp và ngược lại; thiếu event thì phát lại `OrderPaidV1` từ outbox. Đối soát chỉ báo lệch, không tự đổi trạng thái order; `Paid` là terminal, kết quả có thể đến sai thứ tự (đã nêu ở bàn giao Bước 4).
- **Câu hỏi mở:** cách cung cấp snapshot, độ trễ chấp nhận được, định danh tenant trong snapshot.

## 11. Tài liệu kèm theo

[ADR-0010](../../adr/0010-reconciliation-read-only-immutable-runs.vi.md) (đối soát chỉ đọc theo mặc định, run bất biến, ghi bù qua đường nạp bình thường), README, `.env.example`, và mục runbook ngắn: đọc item, đóng ca, xử lý từng `kind` bằng tay.

## 12. Ngoài phạm vi

Chạy phép kiểm tra Wallet↔Orders; bút toán điều chỉnh/đảo; metric và cảnh báo (Bước 6); dọn run cũ; hoàn tiền.
