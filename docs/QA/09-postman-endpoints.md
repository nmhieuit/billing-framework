# Postman EndPoints (liệt kê toàn bộ endpoint)

> Thêm folder **`EndPoints`** vào 4 collection Postman ở `docs/QA/postman/` để người test gọi nhanh từng endpoint và đọc thông số (header, tham số, **enum cho phép**, mã lỗi) ngay trong **Docs** của request.
> Chỉ dựa trên code (controller/route), mỗi thông số có dẫn chứng `file:dòng`. Đã chạy Newman trên mock (mục 6); **chưa chạy với service thật**.

## 1. Đã làm gì

- Mỗi collection (`wallet`, `payment`, `ops`, `reconciliations`) có thêm folder cấp cao `EndPoints` (cùng cấp `Smoke`, `Regression`), mỗi endpoint đúng một request, chia subfolder theo chức năng. Folder `Smoke` và `Regression` chỉ đổi ở các chỗ ghi ở mục 5 và 6 (sửa lỗi script, siết 4 test, thêm `WLT-011`); mọi request khác giữ nguyên.
- Mỗi request có: URL và header dùng biến, body mẫu hợp lệ, pre-request script nhỏ (sinh `Idempotency-Key`, ký webhook), test tối thiểu (status), và Docs Markdown gồm các mục Mục đích, Nguồn, Header, Params, Body, **Enum cho phép**, Response, Mã lỗi, Ví dụ `curl`, Ghi chú test nhanh.
- Mỗi folder `EndPoints` có thêm subfolder **`Enum variants`**: một request cho từng giá trị enum quan trọng (ví dụ `POST /wallets [currency=USD]`, `adjustments [direction=DEBIT]`, `GET .../items [caseStatus=RESOLVED|IGNORED]`, `resolve [status=IGNORED]`, webhook `[type=charge.failed]`, `POST /charges` với `X-Simulate` `fail`, `delay`, `webhook=duplicate|drop`, `response=timeout` và tổ hợp).
- `POST /charges` có **bật sẵn kịch bản `X-Simulate: delay=2`** (charge hoàn tất sau 2 giây); xóa header để hoàn tất ngay.
- Folder `EndPoints` của collection **Ops** tự tạo ví `ep_cust` (VND) trước mỗi request nên chạy độc lập được.
- Với mỗi service có thêm file riêng `endpoints.folder.postman_collection.json` chỉ chứa folder `EndPoints` để import lẻ.

## 2. Cách import / override

1. Ghi đè 4 file `docs/QA/postman/<service>/<service>.postman_collection.json` bằng bản mới (nội dung cũ giữ nguyên, thêm folder `EndPoints` ở cuối). Trong Postman: **Import** lại để thay collection cũ.
2. Hoặc chỉ import các file `endpoints.folder.postman_collection.json` thành collection riêng (không đụng collection cũ).
3. Dùng environment `billing-local` (`wallet_base_url`, `payment_base_url`, `tenant_id`, `actor_id`, `actor_role`, `webhook_secret`). **Không thêm biến environment mới**; các biến chạy là *collection variables* (`ep_*`) do script tự đặt.
4. Chạy từng request, hoặc cả folder `EndPoints` theo thứ tự (Runner/Newman). Một số request phụ thuộc request trước qua biến `ep_*` (ví dụ `GET /topups/:id` cần `POST /topups` trước); thiếu thì Docs của request nói rõ.

**Biến `ep_*`:** `ep_cust` (customer id ổn định cho cả phiên, tự sinh lần đầu), `ep_key` và `ep_idem` (key mới mỗi lần), `ep_today`, `ep_run`, `ep_topup_id`, `ep_topup_amount`, `ep_tx_id`, `ep_order_id`, `ep_run_id`, `ep_item_id`, `ep_charge_id`, `ep_body`/`ep_sig` (webhook). Ví của `ep_cust` phải được tạo bằng `POST /wallets` (collection Wallet) trước khi dùng `ops`.

## 3. Danh sách endpoint (đối chiếu với code)

Kết quả quét controller/route: **20 endpoint duy nhất** (21 request chính, vì `GET /health` có ở cả wallet và payment) và **15 request biến thể enum** ở subfolder `Enum variants` (wallet 3, ops 2, reconciliations 3, payment 7): tổng 36 request trong các folder `EndPoints`. Không thiếu, không thừa so với code.

| Collection | Method | Path | Nguồn |
| --- | --- | --- | --- |
| wallet | GET | `/health` | `services/wallet/src/interface/http/health.controller.ts:5` |
| wallet | POST | `/wallets` | `services/wallet/src/interface/http/wallets.controller.ts:20` |
| wallet | GET | `/wallet` | `services/wallet/src/interface/http/wallets.controller.ts:42` |
| wallet | GET | `/wallet/entries` | `services/wallet/src/interface/http/wallets.controller.ts:47` |
| wallet | POST | `/topups` | `services/wallet/src/interface/http/topups.controller.ts:42` |
| wallet | GET | `/topups/:id` | `services/wallet/src/interface/http/topups.controller.ts:66` |
| wallet | POST | `/webhooks/payment` | `services/wallet/src/interface/http/webhooks.controller.ts:32` |
| ops | POST | `/ops/wallets/:customerId/freeze` | `services/wallet/src/interface/http/ops.controller.ts:51` |
| ops | POST | `/ops/wallets/:customerId/unfreeze` | `services/wallet/src/interface/http/ops.controller.ts:65` |
| ops | POST | `/ops/wallets/:customerId/adjustments` | `services/wallet/src/interface/http/ops.controller.ts:79` |
| ops | POST | `/ops/transactions/:id/reversals` | `services/wallet/src/interface/http/ops.controller.ts:97` |
| ops | POST | `/ops/orders/:orderId/replay-paid` | `services/wallet/src/interface/http/ops.controller.ts:106` |
| ops | GET | `/ops/actions` | `services/wallet/src/interface/http/ops.controller.ts:112` |
| reconciliations | POST | `/reconciliations` | `services/wallet/src/interface/http/reconciliations.controller.ts:40` |
| reconciliations | GET | `/reconciliations/:runId` | `services/wallet/src/interface/http/reconciliations.controller.ts:46` |
| reconciliations | GET | `/reconciliations/:runId/items` | `services/wallet/src/interface/http/reconciliations.controller.ts:51` |
| reconciliations | POST | `/reconciliation-items/:id/resolve` | `services/wallet/src/interface/http/reconciliations.controller.ts:71` |
| payment | GET | `/health` | `services/payment/src/interface/http/health.route.ts:4` |
| payment | POST | `/charges` | `services/payment/src/interface/http/charges.route.ts:19` |
| payment | GET | `/charges/:id` | `services/payment/src/interface/http/charges.route.ts:69` |
| payment | GET | `/settlements` | `services/payment/src/interface/http/settlements.route.ts:12` |

Không có endpoint HTTP nào khác trong code (đã quét `*.controller.ts` của wallet và `*.route.ts` của payment). Luồng RabbitMQ (`OrderReadyForPaymentV1`...) không phải HTTP nên không có request ở đây: xem `03-manual-order-payment.md`.

## 4. Tổng hợp enum đã tìm thấy

| Enum | Giá trị cho phép | Nguồn | Dùng ở |
| --- | --- | --- | --- |
| Currency | `VND`, `USD` | `packages/money/src/money.ts:3` | Mọi endpoint có tiền |
| Topup status | `REQUESTED`, `PENDING`, `SUCCEEDED`, `FAILED` | `services/wallet/src/domain/topup.ts:5` | `GET /topups/:id`, `POST /topups` |
| Topup failureCode (wallet đặt) | `PAYMENT_REJECTED`, `PAYMENT_UNAVAILABLE` (+ mã từ payment) | `services/wallet/src/domain/topup.ts:24` | `GET /topups/:id` |
| Webhook outcome | `APPLIED`, `DUPLICATE`, `UNKNOWN_TOPUP`, `MISMATCH`, `IGNORED` | `services/wallet/src/application/apply-payment-result.ts:33` | `POST /webhooks/payment` (response) |
| Webhook type | `charge.succeeded`, `charge.failed` | `packages/contracts/src/webhook.ts:13` | `POST /webhooks/payment` (body) |
| Webhook status | `SUCCEEDED`, `FAILED` | `packages/contracts/src/webhook.ts:23` | `POST /webhooks/payment` (body) |
| Ledger transaction kind | `TOPUP`, `ORDER_PAYMENT`, `ADJUSTMENT`, `REVERSAL` | `services/wallet/src/domain/ledger-transaction.ts:9` | `GET /wallet/entries`, reversals |
| Tiền tố businessKey | `topup:`, `order:`, `adjustment:`, `reversal:` | `services/wallet/src/domain/ledger-transaction.ts:87` | `GET /wallet/entries` (response) |
| Ops direction | `CREDIT`, `DEBIT` | `services/wallet/src/application/adjust-wallet.ts:37` | `POST /ops/.../adjustments` |
| Ops action | `FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID` | `services/wallet/src/domain/ops.ts:1` | `GET /ops/actions` |
| Lý do thất bại order | `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`, `WALLET_FROZEN` | `packages/contracts/src/events.ts:75` | Sự kiện `OrderPaymentFailedV1` (RabbitMQ), liên quan freeze |
| Run status | `RUNNING`, `COMPLETED`, `FAILED` | `services/wallet/src/application/ports.ts:254` | Đối soát (response) |
| Run trigger | `SCHEDULED`, `MANUAL` | `services/wallet/src/application/ports.ts:255` | Đối soát (response) |
| Loại lệch đối soát | `LEDGER_UNBALANCED`, `BALANCE_MISMATCH`, `MISSING_AT_WALLET`, `UNKNOWN_CHARGE`, `MISSING_AT_GATEWAY`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH` | `services/wallet/src/domain/reconciliation.ts:3` | `GET .../items` (response) |
| Autofix action | `NONE`, `AUTO_APPLIED`, `FAILED_AUTOFIX` | `services/wallet/src/domain/reconciliation.ts:12` | `GET .../items` (response) |
| Case status | `OPEN`, `RESOLVED`, `IGNORED` | `services/wallet/src/domain/reconciliation.ts:13` | `GET .../items?caseStatus=` (query) |
| Resolve status | `RESOLVED`, `IGNORED` | `services/wallet/src/domain/reconciliation.ts:179` | `POST /reconciliation-items/:id/resolve` |
| Charge status | `PENDING`, `SUCCEEDED`, `FAILED` | `services/payment/src/domain/charge.ts:8` | `GET /charges/:id`, `POST /charges` |
| Settlement item status | `SUCCEEDED`, `FAILED` | `services/payment/src/application/get-settlement.ts:20` | `GET /settlements` |
| X-Simulate (khóa) | `fail`, `delay`, `webhook`, `response` | `services/payment/src/domain/scenario.ts:46` | `POST /charges` (header) |
| X-Simulate `webhook` | `drop`, `duplicate` | `services/payment/src/domain/scenario.ts:60` | `POST /charges` (header) |
| X-Simulate `response` | `timeout` | `services/payment/src/domain/scenario.ts:66` | `POST /charges` (header) |

Giá trị có ràng buộc nhưng **không phải enum** (ghi ở mục Params/Body của từng request): regex customer id `^[A-Za-z0-9_-]{1,64}$`, tenant `^[a-z][a-z0-9-]{0,39}$`, `failureCode` `^[a-z][a-z0-9_]{0,63}$`, `delay` `1..3600`, `limit` (entries 1..1000; ops actions 1..200; items 1..500; settlements 1..1000), số tiền topup `1..1_000_000_000_000`, `reason` ≤ 500, `idempotencyKey` ≤ 200, `Idempotency-Key` ≤ 255, `note` ≤ 500, `resolvedBy` ≤ 64.

## 5. Chạy thử và sửa lỗi

Container này không có Docker/SQL Server nên không chạy được service thật. Tôi viết **mock** của wallet (`:3001`) và payment (`:3002`) theo cách đọc code (`postman/mock/server.cjs`) rồi chạy Newman 6 với cả 4 collection (`Smoke`, `Regression`, `EndPoints`), **2 lượt liên tiếp**:

| Collection | Request chạy | Assertion | Lỗi |
| --- | --- | --- | --- |
| payment | 87-88 | 178-180 | 0 |
| wallet | 96 | 201 | 0 |
| ops | 100 | 207 | 0 |
| reconciliations | 55 (10 request ở chế độ đóng ca) | 110 | 0 |

**Lỗi tìm ra và đã sửa** (đều là lỗi của collection, không phải của service):

1. **Request poll chạy test phụ ở mọi vòng lặp**: `PAY-002`, `SIM-001b`, `SIM-003c` kiểm `completedAt`/`failureCode` ngay cả khi charge còn `PENDING` → báo lỗi giả. Nay các test phụ chỉ chạy ở lần poll cuối.
2. **Smoke Đối soát dùng `postman.setNextRequest(null)`** khi không có ca để đóng: lệnh này **kết thúc cả lượt chạy**, nên khi chạy cả collection thì folder `Regression` bị bỏ qua. Nay dùng cờ `resolve_ready` và bỏ qua test (`pm.test.skip`).
3. **`EndPoints` của Ops** gọi vào ví chưa tồn tại (404). Nay folder tự tạo ví `ep_cust` bằng `pm.sendRequest`.

**Giới hạn:** mock do tôi viết từ cùng cách hiểu code nên **không** chứng minh service thật trả đúng như kỳ vọng. Chạy trên stack local để kiểm: những lệch (nếu có) sẽ hiện ở lần chạy đầu. Cách chạy lại: xem `postman/mock/README.md`.

## 6. Đã siết test Regression (theo yêu cầu)

| Test | Trước | Nay | Nguồn |
| --- | --- | --- | --- |
| `WLT-004` (currency `EUR`) | 4xx | `400 INVALID_REQUEST` | services/wallet/src/application/create-wallet.ts:24 |
| `TOP-005` (khách khác đọc topup) | 4xx | `404 TOPUP_NOT_FOUND` | services/wallet/src/application/get-topup.ts:19 |
| `WLT-011` (tenant `ACME`, sai định dạng) — **test mới** | (chưa có) | `403 UNKNOWN_TENANT` | services/wallet/src/infrastructure/tenant-registry.ts:21 |
| `REC-017` (đối soát của tenant khác) | 4xx | `404 RECONCILIATION_NOT_FOUND` | services/wallet/src/application/get-reconciliation-run.ts:2 |

## 7. Cập nhật lên Postman Cloud

Các collection `Billing / Wallet|Payment|Ops|Reconciliations` trên Postman Cloud **chưa được ghi đè**: mỗi bản dài 60 đến 120 KB JSON, vượt khả năng truyền qua công cụ Postman trong phiên làm việc. Hãy **Import** 4 file trong zip và chọn **Replace** khi Postman hỏi (hoặc xóa bản cũ rồi import). Tôi đã tạo bản sao lưu của bản hiện có trên Postman với hậu tố "(backup trước khi ghi đè 2026-10-13)"; có **5 bản sao lưu** (Reconciliations bị tạo hai bản do một lần gọi lỗi), bạn có thể xóa bớt.

## 8. Chưa xác minh

- Chưa chạy với service thật: mọi kỳ vọng suy ra từ code (mock chỉ kiểm script và luồng).
- Dấu (âm/dương) của `amount` trong `GET /wallet/entries` theo từng loại giao dịch.
- Hành vi chính xác của `X-Simulate: webhook=drop` (không tạo event hay tạo rồi không gửi).
- Cấu trúc chi tiết của `totals` trong `GET /settlements`.
- Định dạng id giao dịch (`tx_...`) và dạng `target` của `ops_actions` mới được thấy ở `docs/ops/ops-tools.vi.md`, chưa thấy trong code.
- Ý nghĩa "VND là đồng, USD là cent" lấy từ mô tả schema (`packages/contracts/src/events.ts`), không phải từ `money.ts`.
- Biến thể `response=timeout` mất khoảng 30 giây (mặc định `RESPONSE_TIMEOUT_MS`); mock dùng 2 giây.

## 9. Câu hỏi cần bạn trả lời

1. Chạy các collection trên stack local (Newman hoặc Postman Runner) rồi gửi kết quả để tôi sửa các kỳ vọng lệch.
2. Kịch bản mặc định `delay=2` của `POST /charges` có hợp ý không, hay bạn muốn kịch bản khác (ví dụ `fail=card_declined`) bật sẵn?
