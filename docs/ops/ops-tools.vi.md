# Công cụ vận hành (ops tools) của wallet

Tài liệu cho người vận hành: wallet có một nhóm API `/ops/...` để xử lý các tình huống tiền bạc không tự giải quyết được, gồm đóng
băng/mở băng ví, điều chỉnh số dư, đảo một giao dịch và phát lại `OrderPaidV1` cho Orders. Mọi thao tác đổi trạng thái đều bắt
buộc có `reason` và `idempotencyKey`, và được ghi vào nhật ký kiểm toán `ops_actions` trong cùng transaction với thay đổi. Thiết
kế: [spec 6c](../superpowers/specs/2026-10-12-ops-tools-design.md); quyết định:
[ADR-0013](../adr/0013-ops-tools-audited-actions.vi.md); bàn giao cho Orders:
[orders-handoff](../integration/orders-handoff.vi.md); đối soát: [reconciliation-runbook](../integration/reconciliation-runbook.vi.md).

> **Chỉ dành cho mạng vận hành.** Các route này làm thay đổi tiền của khách. Không đưa chúng vào bộ route hướng khách hàng của
> gateway; dùng network policy hoặc một route gateway riêng có xác thực vận hành.

## Ai được dùng và danh tính lấy từ đâu

Wallet **tin gateway** về danh tính người vận hành (cùng mô hình với `x-tenant-id`/`x-customer-id`). Mỗi lời gọi cần ba header:

| Header          | Ý nghĩa                                                                 | Thiếu / sai thì                    |
| --------------- | ----------------------------------------------------------------------- | ---------------------------------- |
| `x-actor-id`    | Định danh người vận hành (1..100 ký tự), ghi vào `ops_actions.actor`    | `401 MISSING_ACTOR`                |
| `x-actor-role`  | Phải đúng bằng `OPS`; giá trị khác (kể cả `OPS, ADMIN`) bị từ chối      | `403 FORBIDDEN_ROLE`               |
| `x-tenant-id`   | Tenant cần thao tác; mọi dữ liệu và khóa idempotency đều nằm trong tenant | `400 MISSING_TENANT`, `403 UNKNOWN_TENANT` |

Thứ tự kiểm tra là actor, vai trò, rồi tenant. Danh tính **chỉ** lấy từ header; trường `actor` trong body bị bỏ qua hoàn toàn.

> **Gateway PHẢI xóa mọi header `x-actor-*` do client gửi tới** rồi tự đặt từ phiên đã xác thực. Wallet không kiểm chứng gì thêm:
> nếu gateway để lọt `x-actor-id`/`x-actor-role` của client thì bất kỳ ai tới được route này đều mạo danh được người vận hành.

## Các endpoint

| Thao tác        | Đường dẫn                                             | Body (ngoài `reason`, `idempotencyKey`)                    | Thành công |
| --------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ---------- |
| Đóng băng ví    | `POST /ops/wallets/{customerId}/freeze`               | không                                                      | `200`      |
| Mở băng ví      | `POST /ops/wallets/{customerId}/unfreeze`             | không                                                      | `200`      |
| Điều chỉnh ví   | `POST /ops/wallets/{customerId}/adjustments`          | `direction` (`CREDIT`\|`DEBIT`), `amount`, `currency`     | `201`      |
| Đảo giao dịch   | `POST /ops/transactions/{id}/reversals`               | không                                                      | `201`      |
| Phát lại đã trả | `POST /ops/orders/{orderId}/replay-paid`              | không                                                      | `202`      |
| Xem nhật ký     | `GET /ops/actions?limit=&cursor=`                     | không                                                      | `200`      |

Quy tắc chung cho các `POST`:

- Body phải là một đối tượng JSON (nếu không: `400 INVALID_REQUEST`).
- `reason` 1..500 ký tự, `idempotencyKey` 1..200 ký tự, đều bị cắt khoảng trắng hai đầu; rỗng hoặc quá dài là
  `422 INVALID_OPS_REQUEST`.
- `amount` là **số nguyên dương** (minor unit: VND là đồng, USD là cent) dạng số JSON; `currency` phải khớp đồng tiền của ví.

### Idempotency

- Cùng `idempotencyKey` và **cùng nội dung** (cùng thao tác, đối tượng, tham số) gửi lại thì trả lại **đúng kết quả cũ**, không làm
  gì thêm. Mã HTTP vẫn là mã thành công của thao tác đó (ví dụ `201` cho điều chỉnh). Dấu vân tay chỉ gồm thao tác, đối tượng và
  tham số; **`reason` và `actor` không nằm trong đó**. Vì vậy một người vận hành khác gửi cùng khóa và cùng tham số sẽ nhận kết quả
  của lần đầu và **không** có dòng kiểm toán mới (dòng cũ vẫn ghi người và lý do của lần đầu).
- Cùng `idempotencyKey` nhưng **khác** thao tác/đối tượng/tham số: `409 IDEMPOTENCY_CONFLICT`.
- Thao tác lỗi (4xx) rollback hết và **không giữ khóa**, nên sửa yêu cầu rồi gửi lại với cùng khóa là hợp lệ.
- Hai yêu cầu cùng khóa đến song song được **tuần tự hóa theo khóa** (khóa ứng dụng `sp_getapplock` mức transaction, chờ tối đa 10 giây,
  lấy trước mọi khóa tài khoản nên không deadlock): bên đến sau chờ bên đầu commit rồi nhận **đúng kết quả đã lưu của bên thắng**
  (kể cả `changed: true` của đóng băng và cùng `actionId`), chỉ có một giao dịch/dòng kiểm toán. Chốt chặn cuối là khóa unique của
  `ops_actions` (bên thua được chạy lại một lần). Hết thời gian chờ khóa là `500`, gửi lại cùng khóa là an toàn.
- Đóng băng ví đã đóng băng (hoặc mở băng ví đang mở) là **no-op**: trả `200` với `changed: false` và **không ghi `ops_actions`**
  (nên cũng không giữ khóa).
- Khóa chỉ có nghĩa trong một tenant; cùng khóa ở tenant khác không va chạm.

## Từng thao tác

Các ví dụ dùng wallet local (`localhost:3001`). Header dùng chung:

```bash
H='-H x-tenant-id:acme -H x-actor-id:an.nguyen -H x-actor-role:OPS -H content-type:application/json'
```

### Đóng băng / mở băng ví

Ví đóng băng **không trả được order**: `OrderReadyForPaymentV1` của ví đó bị từ chối với `OrderPaymentFailedV1(WALLET_FROZEN)`.
Nạp tiền vẫn được nhận, và điều chỉnh/đảo vẫn chạy được trên ví đóng băng để điều tra. Chỉ ví (`WALLET`) mới đóng băng được.
Ví chưa tồn tại: `404 WALLET_NOT_FOUND`.

```bash
curl -s -X POST localhost:3001/ops/wallets/c1/freeze $H \
  -d '{"reason":"khách báo nhầm tiền, ticket 123","idempotencyKey":"freeze-c1-123"}'
# 200 {"customerId":"c1","frozen":true,"changed":true,"frozenAt":"2026-10-12T03:00:00.000Z","actionId":"..."}

curl -s -X POST localhost:3001/ops/wallets/c1/unfreeze $H \
  -d '{"reason":"đã xử lý xong, ticket 123","idempotencyKey":"unfreeze-c1-123"}'
# 200 {"customerId":"c1","frozen":false,"changed":true,"frozenAt":null,"actionId":"..."}
```

Khi no-op (`changed: false`), `actionId` là `null`. Người đóng băng, lý do và thời điểm nằm ở `accounts.frozen_by`,
`frozen_reason`, `frozen_at`.

### Điều chỉnh số dư

Một giao dịch `ADJUSTMENT` hai dòng giữa ví và tài khoản hệ thống `system:ADJUSTMENT:<cur>`: `CREDIT` cộng ví, `DEBIT` trừ ví.
Sổ cái vẫn cân và vẫn chỉ thêm. Chạy được trên ví đóng băng.

```bash
curl -s -X POST localhost:3001/ops/wallets/c1/adjustments $H \
  -d '{"direction":"DEBIT","amount":150000,"currency":"VND","reason":"thu hồi tiền nạp nhầm, ticket 123","idempotencyKey":"adj-c1-123"}'
# 201 {"transactionId":"tx_...","actionId":"..."}
```

Lỗi có thể gặp: `404 WALLET_NOT_FOUND`; `422 INVALID_OPS_REQUEST` (`direction` sai, `amount` không phải số nguyên dương, sai đồng
tiền, thiếu `reason`/`idempotencyKey`); `409 INSUFFICIENT_FUNDS` (xem bảng mã lỗi: `DEBIT` sẽ làm ví âm).

### Đảo một giao dịch

Chỉ đảo được giao dịch `ORDER_PAYMENT` hoặc `ADJUSTMENT`. Wallet **không sửa giao dịch gốc** mà ghi thêm một giao dịch `REVERSAL`
có các dòng đối nghịch từng dòng của giao dịch gốc, trỏ về nó bằng `reverses_transaction_id`. Mỗi giao dịch chỉ bị đảo một lần
(chỉ mục unique có lọc là chốt cuối khi chạy song song). Chạy được trên ví đóng băng.

```bash
curl -s -X POST localhost:3001/ops/transactions/tx_5b1d0c1c8a3f4e6f9a7b2c4d6e8f0a1b/reversals $H \
  -d '{"reason":"order bị hủy sau khi trả, ticket 456","idempotencyKey":"rev-tx5b1d-456"}'
# 201 {"transactionId":"tx_...","reversesTransactionId":"tx_5b1d...","actionId":"..."}
```

Dòng `order_payments` của order bị đảo **được giữ nguyên**, nhưng `OrderReadyForPaymentV1` của order đó giao lại sẽ bị **từ chối** với
`OrderPaymentFailedV1(CONFLICT)`: không ghi nợ thêm và không phát lại `OrderPaidV1` (wallet ghi một cảnh báo). Orders đã bỏ qua
thất bại của order đang ở trạng thái `Paid`.

Lỗi có thể gặp: `404 TRANSACTION_NOT_FOUND`, `409 ALREADY_REVERSED`, `409 REVERSAL_NOT_SUPPORTED` (loại `TOPUP` hoặc `REVERSAL`),
`409 REVERSAL_NOT_POSSIBLE`, `409 INSUFFICIENT_FUNDS` (xem bảng dưới).

### Phát lại `OrderPaidV1`

Dùng khi Orders mất sự kiện `OrderPaidV1` của một order đã trả. Wallet ghi **một dòng outbox mới** (id mới) với payload dựng từ
`order_payments`: **giữ nguyên `eventId`** và thời điểm của sự kiện gốc (`occurredAtUtc` = `paidAtUtc` = `order_payments.paid_at`),
`correlationId = ops-replay:<actionId>`. Không đụng tới sổ cái, không đổi số dư. Relay gửi đi như mọi sự kiện outbox khác.

```bash
curl -s -X POST localhost:3001/ops/orders/0b1f3c6e-6a4e-4d0f-8a4b-9f1d7b6f0c11/replay-paid $H \
  -d '{"reason":"Orders chưa chuyển Paid, ticket 789","idempotencyKey":"replay-0b1f-789"}'
# 202 {"eventId":"<eventId gốc>","actionId":"..."}
```

Lỗi có thể gặp: `404 ORDER_NOT_FOUND` (order chưa được trả ở tenant này), `409 ORDER_REVERSED` (khoản trả đã bị đảo, không phát lại
`OrderPaidV1` cho đơn đã hoàn), `409 EVENT_ID_UNKNOWN` (xem "Hạn chế").

> **`eventId` giữ nguyên, nhưng `messageId` AMQP thì mới.** `messageId` của thuộc tính AMQP là id dòng outbox; với sự kiện phát lần
> đầu nó bằng `eventId`, còn với bản phát lại nó là id outbox mới. Consumer **phải khử trùng theo `eventId` trong payload**, không
> theo `messageId` AMQP (xem [orders-handoff](../integration/orders-handoff.vi.md)).

### Xem nhật ký

```bash
curl -s "localhost:3001/ops/actions?limit=20" $H
# 200 {"items":[{"id":"...","action":"ADJUST","actor":"an.nguyen","reason":"...","target":"wallet:c1","createdAt":"..."}],"nextCursor":"42"}
curl -s "localhost:3001/ops/actions?limit=20&cursor=42" $H
```

Mới nhất trước; `limit` 1..200 (mặc định 50); `cursor` là `nextCursor` của trang trước (số `seq` nguyên dương); `limit`/`cursor` sai
hoặc lặp tham số: `400 INVALID_QUERY`. `nextCursor` là `null` khi trang ngắn hơn `limit`. Danh sách **không** trả khóa idempotency,
dấu vân tay hay `result`. Route này cũng đòi `x-actor-id` và role `OPS`.

## Bảng mã lỗi

| Mã HTTP | Mã lỗi (`error.code`)     | Khi nào                                                                                                   |
| ------- | ------------------------- | --------------------------------------------------------------------------------------------------------- |
| 400     | `MISSING_TENANT`          | thiếu `x-tenant-id`                                                                                       |
| 400     | `INVALID_REQUEST`         | body không phải đối tượng JSON, hoặc `customerId` trên đường dẫn sai định dạng                            |
| 400     | `INVALID_QUERY`           | `limit`/`cursor` sai hoặc lặp                                                                             |
| 401     | `MISSING_ACTOR`           | thiếu `x-actor-id`                                                                                        |
| 403     | `FORBIDDEN_ROLE`          | `x-actor-role` khác `OPS`                                                                                 |
| 403     | `UNKNOWN_TENANT`          | tenant không được wallet phục vụ                                                                          |
| 404     | `WALLET_NOT_FOUND`        | ví của `customerId` không tồn tại                                                                         |
| 404     | `TRANSACTION_NOT_FOUND`   | không có giao dịch với id đó                                                                              |
| 404     | `ORDER_NOT_FOUND`         | order chưa có khoản trả (`order_payments`)                                                                |
| 409     | `IDEMPOTENCY_CONFLICT`    | `idempotencyKey` đã dùng cho yêu cầu khác                                                                 |
| 409     | `ALREADY_REVERSED`        | giao dịch đã bị đảo                                                                                       |
| 409     | `REVERSAL_NOT_SUPPORTED`  | giao dịch loại `TOPUP` hoặc `REVERSAL`                                                                    |
| 409     | `REVERSAL_NOT_POSSIBLE`   | số dư hiện tại của tài khoản đối ứng (thực tế là MERCHANT) không cho phép đảo, vì sẽ làm nó âm              |
| 409     | `INSUFFICIENT_FUNDS`      | **ví** không đủ tiền cho phép thao tác: `DEBIT` quá số dư, hoặc đảo một `ADJUSTMENT CREDIT` khi ví đã tiêu mất |
| 409     | `ORDER_REVERSED`          | phát lại cho order mà khoản trả đã bị đảo                                                                 |
| 409     | `EVENT_ID_UNKNOWN`        | order không có `paid_event_id` nên không phát lại được                                                    |
| 422     | `INVALID_OPS_REQUEST`     | `reason`/`idempotencyKey` rỗng hoặc quá dài, `direction`/`amount`/`currency` sai                          |

Phân biệt hai mã dễ nhầm: `INSUFFICIENT_FUNDS` nói về **ví của khách** (số dư không đủ để trừ), còn `REVERSAL_NOT_POSSIBLE` nói về
**tài khoản đối ứng** (đảo một khoản trả order thì MERCHANT bị trừ lại; nếu MERCHANT đã không còn đủ số dư thì đảo sẽ phá bất biến
số dư nên bị từ chối). Cả hai đều rollback hoàn toàn, không ghi gì.

## Quy trình khuyến nghị

**Khách báo nhầm tiền (nạp nhầm, trừ nhầm).**

1. Đóng băng ví (`freeze`) để dừng việc trả order trong lúc điều tra. Ghi ticket vào `reason`.
2. Điều tra: xem sổ cái (`GET /wallet/entries`), `topups`, đối soát ([runbook](../integration/reconciliation-runbook.vi.md)).
3. Sửa bằng `adjustments` (khoản nạp/trừ nhầm), hoặc `reversals` nếu cần hoàn tác đúng một giao dịch `ORDER_PAYMENT`/`ADJUSTMENT`.
4. Mở băng ví (`unfreeze`). Kiểm tra lại số dư và `ops_actions`.

**Orders mất `OrderPaidV1`** (order còn `Unpaid` dù ví đã bị trừ): kiểm tra `order_payments` có order đó, rồi `replay-paid`. Orders khử
trùng theo `eventId` nên an toàn dù sự kiện thật ra đã đến.

**Đảo thanh toán của một order.** Wallet **không phát sự kiện hoàn tiền** cho Orders (chưa có hợp đồng như `OrderRefundedV1`). Sau
khi `reversals` thành công, **người vận hành phải tự báo Orders** để họ hủy/hoàn order. Đừng chạy `replay-paid` cho order đó: nó bị
từ chối `ORDER_REVERSED`.

**Đóng ca đối soát cần sửa số dư.** Dùng `adjustments` rồi đóng ca đối soát với ghi chú trỏ tới `actionId`/`transactionId`; xem
[reconciliation-runbook](../integration/reconciliation-runbook.vi.md).

## Nhật ký `ops_actions`

Mỗi thao tác **đổi trạng thái** ghi đúng một dòng, trong cùng transaction với thay đổi (thao tác lỗi hay no-op không ghi).
Bảng nằm trong schema của từng tenant (`t_<tenant>.ops_actions`):

| Cột               | Ý nghĩa                                                                                       |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `seq`             | số tăng dần (identity), dùng để sắp xếp và phân trang                                         |
| `id`              | id thao tác, chính là `actionId` trả về                                                       |
| `action`          | `FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID`                                      |
| `actor`           | người vận hành, từ `x-actor-id`                                                               |
| `reason`          | lý do                                                                                         |
| `target`          | `wallet:<customerId>`, `transaction:<id>` hoặc `order:<orderId>`                              |
| `idempotency_key` | khóa idempotency (unique trong tenant)                                                        |
| `fingerprint`     | SHA-256 của `{action, target, params}`                                                        |
| `result`          | JSON kết quả đã trả, dùng để phát lại khi gọi lại cùng khóa                                   |
| `created_at`      | thời điểm thao tác                                                                            |

Bảng **chỉ thêm**: trigger `trg_ops_actions_append_only` chặn mọi `UPDATE` và `DELETE` (lỗi `ops_actions is append-only`). Job
retention **không bao giờ xóa** `ops_actions` ([retention](retention.vi.md)): đây là bằng chứng kiểm toán nên không có hạn dọn.

Truy vấn mẫu (thay `t_acme` bằng schema của tenant):

```sql
-- 50 thao tác gần nhất
SELECT TOP (50) seq, action, actor, target, reason, created_at
FROM t_acme.ops_actions ORDER BY seq DESC;

-- Mọi thao tác trên một ví
SELECT seq, action, actor, reason, created_at
FROM t_acme.ops_actions WHERE target = 'wallet:c1' ORDER BY seq;

-- Các ví đang đóng băng và ai đóng
SELECT customer_id, frozen_at, frozen_by, frozen_reason
FROM t_acme.accounts WHERE frozen_at IS NOT NULL;
```

## Hạn chế cần biết

- **Không đảo được `TOPUP`** (`REVERSAL_NOT_SUPPORTED`): đối soát Wallet ↔ Gateway chưa biết hiểu giao dịch đảo của khoản nạp. Muốn
  thu hồi tiền nạp nhầm thì dùng `adjustments` `DEBIT`.
- **Không có sự kiện hoàn tiền cho Orders** khi đảo thanh toán order: ops phải tự báo Orders (xem quy trình trên).
- **Phát lại cần `paid_event_id`.** Cột này chỉ có từ migration `007-ops-tools`. Migration backfill từ dòng outbox `OrderPaidV1` còn
  lại; order trả **trước** migration mà dòng outbox đã bị retention dọn (sau `RETENTION_OUTBOX_SENT_DAYS` ngày) thì không còn
  `eventId` gốc, và `replay-paid` trả `409 EVENT_ID_UNKNOWN`. Wallet không đoán `eventId` mới vì làm vậy consumer sẽ không khử trùng được.
- **Phát lại và đảo được tuần tự hóa bằng khóa ví.** `replay-paid` khóa hàng ví của khách (đúng hàng mà `reversals` giữ cho
  `ORDER_PAYMENT`) trước khi kiểm tra khoản trả đã bị đảo chưa. Nếu một `reversals` của chính order đó đang chạy, phát lại chờ nó
  commit rồi bị từ chối `ORDER_REVERSED`, nên không có chuyện `OrderPaidV1` được xếp hàng cho một khoản vừa bị đảo.
- **Đóng băng chỉ chặn ghi nợ do trả order.** Nạp tiền, điều chỉnh và đảo vẫn chạy trên ví đóng băng.
- **Cần Orders triển khai trước khi người vận hành dùng freeze ở môi trường dùng chung:** `WALLET_FROZEN` là lý do mới của
  `OrderPaymentFailedV1` (xem [orders-handoff](../integration/orders-handoff.vi.md)). **Không có công tắc bật/tắt**: ngay khi image
  mới chạy, route `/ops/...` dùng được và một lệnh `freeze` là bắt đầu phát `WALLET_FROZEN`.
- Tin gateway về header actor (xem trên); `ops_actions.actor` chỉ đáng tin bằng gateway.

## Triển khai và rollback

- **Triển khai:** chạy `db:migrate:wallet` (migration `007-ops-tools`) **trước** khi chạy image mới; wallet kiểm tra `assertMigrated`
  lúc khởi động nên image mới không lên được nếu schema chưa có 007. Migration chưa phát hành nên đã được sửa tại chỗ; môi trường đã
  chạy bản cũ không cần chạy lại (chỉ khác cách backfill, không khác schema).
- **Rollback code sau khi đã chạy 007 là an toàn** (code cũ bỏ qua cột và tài khoản mới), nhưng: (1) đóng băng **không còn được áp dụng**
  (code cũ không biết `frozen_at`, ví đang đóng băng trả order bình thường); (2) order được trả trong thời gian rollback có
  `paid_event_id` = null nên `replay-paid` cho chúng trả `409 EVENT_ID_UNKNOWN`. Không cần rollback schema.

## Metric `billing.ops.actions`

Counter `billing.ops.actions` với nhãn `tenant`, `action` (`FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID`) và `outcome`:

- `ok`: thao tác đổi trạng thái và đã ghi một dòng `ops_actions`.
- `noop`: **không ghi gì mới**. Gộp hai trường hợp: (1) freeze/unfreeze khi ví đã đúng trạng thái; (2) gọi lại cùng
  `idempotencyKey` và cùng nội dung (kết quả cũ được trả lại). Vì vậy `noop` cao thường chỉ là client gửi lại, không phải lỗi.
- `rejected`: bị từ chối (đầu vào sai, không tìm thấy, xung đột idempotency, đảo không khả thi...). Cũng đếm lỗi hạ tầng bất ngờ.

Không có rule Kibana riêng cho metric này; `ops_actions` là nguồn kiểm toán. Thêm một dòng log `info` `ops action recorded` (có
`tenantId`, `action`, `actor`, `target`) cho mỗi thao tác `ok`. Tên trường trong Elasticsearch: [metric-fields](metric-fields.md).

## Xử lý sự cố

| Triệu chứng                                       | Nguyên nhân thường gặp và việc cần làm                                                                           |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `401 MISSING_ACTOR` / `403 FORBIDDEN_ROLE`        | Gateway không đặt `x-actor-id` hoặc `x-actor-role: OPS`; kiểm tra cấu hình route vận hành của gateway            |
| `409 IDEMPOTENCY_CONFLICT`                        | Dùng lại khóa cho yêu cầu khác. Đổi khóa nếu thật sự là thao tác mới; xem `ops_actions` để biết khóa đã dùng cho gì |
| Gọi lại bị lỗi 5xx giữa chừng, không chắc đã chạy chưa | Gửi lại **cùng khóa, cùng nội dung**: nếu đã chạy sẽ nhận kết quả cũ, nếu chưa sẽ chạy một lần              |
| `409 REVERSAL_NOT_POSSIBLE`                       | MERCHANT không đủ số dư để hoàn; không đảo được. Dùng `adjustments` ở phía ví và xử lý phần MERCHANT ngoài hệ thống |
| `409 EVENT_ID_UNKNOWN`                            | Order cũ trước migration 007 và outbox đã bị dọn; không phát lại được. Báo Orders đối chiếu trạng thái order bằng tay |
| Ví bị đóng băng nhưng khách vẫn thấy order bị từ chối | Đúng thiết kế: `OrderPaymentFailedV1(WALLET_FROZEN)`. Mở băng rồi Orders gửi lại `OrderReadyForPaymentV1` (cùng `orderId`) |
| Orders vẫn không chuyển `Paid` sau `replay-paid`  | Xem outbox (`billing-outbox-stuck`), queue của Orders gắn vào `billing.events`, [dlq-runbook](../integration/dlq-runbook.vi.md) |
