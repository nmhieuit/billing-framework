# Bước 6c — Công cụ vận hành (ops tools): thiết kế

**Ngày:** 2026-10-12
**Trạng thái:** Đã triển khai (các điểm code khác bản thiết kế ban đầu được ghi ở mục 9)
**Phạm vi:** Bốn công cụ cho người vận hành trong **wallet** — đóng/mở băng ví, điều chỉnh số dư, đảo giao dịch, phát lại `OrderPaidV1` — cùng nhật ký kiểm toán chung, API `/ops/...` và quan sát tối thiểu. Là vòng ba của Bước 6. Dựa trên sổ cái kép (ADR-0002), trả order từ ví (`2026-10-10-order-payment-integration-design.md`), đối soát (ADR-0010) và retention (ADR-0012). Payment không đổi.

## 1. Quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Danh tính người vận hành | Gateway đã xác thực rồi đặt header `x-actor-id` và `x-actor-role: OPS` (cùng mô hình tin gateway của `x-tenant-id`/`x-customer-id`). Service đòi cả hai, role khác `OPS` bị từ chối. Actor không bao giờ đọc từ body |
| 2 | Bút toán | **Đảo giao dịch** (reversal) và **điều chỉnh** (adjustment) có đối ứng với tài khoản hệ thống mới `system:ADJUSTMENT:<cur>`. Sổ cái chỉ thêm, không sửa/xóa dòng cũ |
| 3 | Đóng băng | Chặn **mọi khoản ghi nợ ví** (trả order). Nạp tiền vào ví vẫn nhận. Điều chỉnh và đảo vẫn chạy trên ví đóng băng để điều tra |
| 4 | Phát lại | Giữ **nguyên `eventId`** của `OrderPaidV1`, chỉ cho order đã `PAID` và chưa bị đảo; không tạo giao dịch sổ cái |
| 5 | Mọi thao tác | Bắt buộc `reason` (1–500 ký tự) và `idempotencyKey`; mỗi thao tác đổi trạng thái ghi một dòng `ops_actions` trong cùng transaction |
| 6 | Ngoài phạm vi | Đảo giao dịch `TOPUP` (cần dạy đối soát Wallet↔Gateway hiểu giao dịch đảo) và sự kiện cho Orders khi đảo thanh toán (cần hợp đồng mới kiểu `OrderRefundedV1`). Ops tự báo bên Orders. Không thêm rule Kibana |

## 2. Dữ liệu — migration tenant `007-ops-tools`

Chạy trong từng schema tenant, mẫu như `003-orders` (drop rồi add lại CHECK đã kiểm chứng an toàn trên bảng có trigger bất biến).

- `accounts`: cột `frozen_at datetime2(3) null`, `frozen_by nvarchar(100) null`, `frozen_reason nvarchar(500) null`; CHECK loại tài khoản thêm `'ADJUSTMENT'`. Tài khoản đang đóng băng khi `frozen_at is not null`. Chỉ ví (`WALLET`) được đóng băng.
- `ledger_transactions`: CHECK `kind` thêm `'ADJUSTMENT'`, `'REVERSAL'`; cột `reverses_transaction_id nvarchar(64) null` tham chiếu `ledger_transactions(id)`; **chỉ mục unique có lọc** `where reverses_transaction_id is not null` để một giao dịch chỉ bị đảo một lần.
- `order_payments`: cột `paid_event_id nvarchar(64) null` = `eventId` của `OrderPaidV1` ban đầu. Backfill: với mỗi dòng, tìm dòng `outbox` còn lại có `event_type = 'OrderPaidV1'` và payload JSON khớp `orderId`, lấy `eventId` từ payload; không tìm thấy thì để null. Cần cột này vì dòng outbox gốc bị retention dọn sau `RETENTION_OUTBOX_SENT_DAYS` ngày.
- Bảng `ops_actions` (chỉ thêm): `id`, `action` (`FREEZE` | `UNFREEZE` | `ADJUST` | `REVERSE` | `REPLAY_PAID`), `actor`, `reason`, `target` (ví/giao dịch/order), `idempotency_key` **unique**, `fingerprint` (băm yêu cầu), `result` (JSON kết quả đã trả), `created_at`. Cột `seq bigint identity` làm khóa chính để sắp xếp và phân trang (không có chỉ mục theo `created_at`); trigger `instead of update, delete` chặn sửa/xóa.
- Tài khoản `system:ADJUSTMENT:<cur>` được tạo khi cần (cùng cách tạo tài khoản hệ thống hiện có); số dư không bị ràng buộc dấu.

Danh sách migration tenant ghim trong các test (provisioning, orders-migration) được cập nhật thêm `007-ops-tools`; thêm `ops-migration.integration.test.ts` kiểm chứng chạy lại không đổi gì và backfill đúng.

## 3. Hành vi

**Idempotency chung (`OpsActionRecorder`).** Trong transaction: tìm `ops_actions` theo `idempotency_key`; có và cùng `fingerprint` → trả lại `result` cũ (không làm gì thêm); có nhưng khác `fingerprint` → 409 `IDEMPOTENCY_CONFLICT`; chưa có → thực hiện, ghi `ops_actions` cùng transaction. Va chạm unique do chạy song song được thử lại một lần như `PayOrder` xử lý `DuplicateKeyError`. Hai thao tác no-op (freeze ví đã đóng băng, unfreeze ví đang mở) trả 200 `changed:false` và **không** ghi `ops_actions`. Trong metric, `outcome = noop` gộp cả hai trường hợp này lẫn gọi lại cùng khóa cùng nội dung (phát lại kết quả cũ).

**Freeze / unfreeze.** `POST /ops/wallets/{customerId}/freeze` và `/unfreeze`, body `{reason, idempotencyKey}`. Ví không tồn tại → 404 `WALLET_NOT_FOUND`.

**Điều chỉnh.** `POST /ops/wallets/{customerId}/adjustments`, body `{direction: 'CREDIT'|'DEBIT', amount, currency, reason, idempotencyKey}`. Một giao dịch `ADJUSTMENT` hai dòng giữa ví và `system:ADJUSTMENT:<cur>`: `CREDIT` cộng ví, `DEBIT` trừ ví. Khóa ví rồi tài khoản hệ thống theo thứ tự cố định như `PayOrder`. `DEBIT` làm ví âm → 409 `INSUFFICIENT_FUNDS`. Sai đồng tiền so với ví → 422. `amount` phải là số nguyên dương.

**Đảo giao dịch.** `POST /ops/transactions/{id}/reversals`, body `{reason, idempotencyKey}`. Giao dịch gốc phải là `ORDER_PAYMENT` hoặc `ADJUSTMENT`; `TOPUP`/`REVERSAL` → 409 `REVERSAL_NOT_SUPPORTED`. Giao dịch `REVERSAL` mới có các dòng đối nghịch từng dòng của giao dịch gốc và `reverses_transaction_id = id`.
- `ORDER_PAYMENT`: ví +amount, MERCHANT −amount; MERCHANT không đủ số dư → 409 `REVERSAL_NOT_POSSIBLE`.
- `ADJUSTMENT`: làm ngược bút toán gốc; ví không đủ tiền → 409 `INSUFFICIENT_FUNDS`.
- Đã bị đảo → 409 `ALREADY_REVERSED` (chỉ mục unique là chốt chặn cuối khi chạy song song).
- Không tồn tại → 404 `TRANSACTION_NOT_FOUND`.
- Dòng `order_payments` của order bị đảo **giữ nguyên**: `OrderReadyForPaymentV1` giao lại vẫn ra "đã trả", không ghi nợ thêm.

**Phát lại `OrderPaidV1`.** `POST /ops/orders/{orderId}/replay-paid`, body `{reason, idempotencyKey}`. Đọc `order_payments`; không có → 404 `ORDER_NOT_FOUND`; giao dịch thanh toán đã bị đảo → 409 `ORDER_REVERSED`; `paid_event_id` null → 409 `EVENT_ID_UNKNOWN`. Ngược lại ghi **một dòng outbox mới** với `outbox.id` mới nhưng payload dựng từ `order_payments` (`eventId = paid_event_id`, `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc = paid_at`, `occurredAtUtc = paid_at`, `correlationId = ops-replay:<ops_action_id>`). Bên nhận khử trùng theo `eventId` nên an toàn; đây là cách đưa lại sự kiện bị mất mà không làm lệch sổ cái. Trả 202 `{eventId}`.

**Chặn khi đóng băng.** `PayOrder`, sau khi khóa ví, nếu `frozen_at` khác null → nhánh từ chối với lý do `WALLET_FROZEN` (vẫn commit inbox + outbox `OrderPaymentFailedV1`, như các từ chối khác). Chỉ thanh toán order bị chặn; nạp tiền, điều chỉnh và đảo vẫn chạy.

**Hợp đồng.** `OrderPaymentFailedV1.reason` (JSON Schema trong `packages/contracts/src/events.ts`) thêm giá trị `WALLET_FROZEN`. Đây là thay đổi hợp đồng cần phối hợp với bên Orders: consumer kiểm tra enum chặt sẽ từ chối giá trị mới. Kế hoạch triển khai phải (a) cập nhật contract test/Pact, (b) ghi vào `docs/integration/orders-handoff.vi.md` rằng consumer phải chấp nhận lý do lạ như "thất bại, giữ `Unpaid`", và (c) nêu rõ trong ADR để bên Orders triển khai trước khi bật freeze ở môi trường dùng chung.

**Nhật ký.** `GET /ops/actions?limit&cursor` (chỉ đọc, giảm dần theo `seq`, `limit` 1..200, mặc định 50; `cursor` = `seq` của dòng cuối trang trước, `nextCursor` là `null` khi trang ngắn hơn `limit`) trả các dòng `ops_actions`; không cần role khác ngoài `OPS`.

## 4. Phân lớp

- **Domain:** `Account` thêm loại `ADJUSTMENT` và trạng thái đóng băng (`freeze`, `unfreeze`, `isFrozen`); `LedgerTransaction.adjustment` và `.reversal` kiểm tra cân bằng như `topup`/`orderPayment`; `WalletFrozenError`.
- **Application:** `OpsActionRecorder` (helper), `FreezeWallet`, `AdjustWallet`, `ReverseTransaction`, `ReplayOrderPaid`, `ListOpsActions`; `PayOrder` thêm nhánh `WALLET_FROZEN` và ghi `paid_event_id`; `Repositories.ops` là port mới; `Metrics.opsAction`.
- **Infrastructure:** migration `007`, `ops.repository.ts`, mở rộng `account.repository`, `ledger.repository` (tìm giao dịch và đã-đảo) và `order-payment.repository` (`paid_event_id`).
- **Interface:** `OpsGuard` (đọc header, không đọc body), `OpsController`, ánh xạ lỗi sang mã HTTP.
- ESLint hexagonal hiện có giữ nguyên; OTel chỉ ở adapter metric.

## 5. Quan sát

Counter `billing.ops.actions{tenant, action, outcome}` với `outcome` là `ok` | `noop` | `rejected`, ghi qua `Metrics.opsAction`. Mỗi thao tác ghi một dòng log `info` có `actor`, `action`, `target`, `tenantId`, `correlationId` (không ghi `reason` dài nếu vượt giới hạn, không ghi bí mật). Không rule Kibana; `ops_actions` là nguồn kiểm toán.

## 6. Kiểm thử

- **Unit:** domain (đóng băng, giao dịch điều chỉnh/đảo cân bằng, đồng tiền); từng use case với repository giả (idempotency, các nhánh lỗi); `OpsGuard`; `PayOrder` với ví đóng băng.
- **Integration (SQL Server thật):** migration 007 chạy lại và backfill; đảo hai lần (kể cả song song) chỉ một lần thành công; cùng `idempotencyKey` song song chỉ tạo một giao dịch, khác yêu cầu → 409; ví đóng băng vẫn nhận nạp, từ chối trả order và có `OrderPaymentFailedV1` với `WALLET_FROZEN`; phát lại giữ nguyên `eventId`, không tạo giao dịch sổ cái, bị từ chối sau khi đảo; một ví có điều chỉnh/đảo vẫn qua đối soát nội bộ không chênh lệch; kiểm tra HTTP cho 401/403/404/409/422.
- **E2E:** trên compose, đóng băng một ví, gửi `OrderReadyForPaymentV1` và xác nhận `OrderPaymentFailedV1` ra ngoài.
- **Contract:** schema `OrderPaymentFailedV1` chấp nhận `WALLET_FROZEN`; Pact/contract test được cập nhật.

## 7. Tài liệu

`docs/ops/ops-tools.vi.md` (tình huống thường gặp, ví dụ `curl` với header actor, quy trình đảo, cách đọc `ops_actions`), ADR-0013, cập nhật README, `reconciliation-runbook` (dùng điều chỉnh khi đóng ca đối soát), `local-stack.vi.md`, `orders-handoff.vi.md` (lý do `WALLET_FROZEN`, phát lại).

## 8. Rủi ro và điểm cần lưu ý

- Sửa CHECK trên bảng có trigger bất biến: dùng đúng mẫu của migration 003.
- Mỗi tenant có migration riêng: kiểm thử provisioning và danh sách migration ghim.
- `paid_event_id` của đơn cũ có thể null nếu outbox đã bị dọn: phát lại các đơn đó bị từ chối rõ ràng (409), không đoán `eventId`.
- Khóa idempotency ops là trong tenant; cùng khóa ở tenant khác không va chạm.
- Header actor tin gateway: triển khai thật phải bảo đảm gateway xóa mọi `x-actor-*` do client gửi.

## 9. Khác biệt giữa thiết kế và bản triển khai

- **Phân trang nhật ký theo `seq`, không theo `created_at`**: bảng có cột identity `seq`; `cursor` là `seq`, sắp xếp giảm dần theo `seq`, không có chỉ mục `created_at` (mục 2, 3).
- **Metric `noop`** bao gồm cả "đã đúng trạng thái" (freeze/unfreeze) lẫn "gọi lại idempotent" (mục 5).
- **Phát lại và đảo có thể đua nhau**: phát lại không khóa tài khoản của ví nên một phát lại chạy đúng lúc đảo của cùng order vẫn có thể xếp hàng `OrderPaidV1`; không chặn bằng khóa mà ghi thành quy tắc vận hành ([ops-tools](../../ops/ops-tools.vi.md)).
- **`messageId` AMQP của bản phát lại là id outbox mới**, khác `eventId` (giữ nguyên trong payload); consumer khử trùng theo `eventId` ([orders-handoff](../../integration/orders-handoff.vi.md)).
- **`INSUFFICIENT_FUNDS` cũng áp dụng khi đảo `ADJUSTMENT CREDIT`** mà ví đã tiêu mất (không chỉ `DEBIT`); `REVERSAL_NOT_POSSIBLE` chỉ nói về tài khoản đối ứng (MERCHANT).
- `occurredAtUtc` của bản phát lại bằng `paidAtUtc` gốc; `correlationId = ops-replay:<actionId>`.

Tài liệu: [`docs/ops/ops-tools.vi.md`](../../ops/ops-tools.vi.md), [ADR-0013](../../adr/0013-ops-tools-audited-actions.vi.md).
