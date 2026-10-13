# Manual test plan: Payment simulator

> **Giai đoạn 2, nhóm B.** Môi trường: **local stack** (`deploy/compose.local.yml`); QA tự đặt header (đã xác nhận); được phép ghi dữ liệu.
> Mọi "kết quả mong đợi" **đọc từ code, chưa chạy thật**; cột "Cơ sở" trỏ file. Chỗ chưa chắc ghi **[Chưa xác minh]**: người test ghi lại giá trị thực tế khi chạy lần đầu.
> Payment là cổng thanh toán **giả lập**: tạo charge, hoàn tất theo kịch bản `X-Simulate`, gửi webhook về wallet, cung cấp sao kê (`README.md`, mục Payment simulator).

## 1. Chuẩn bị

| Hạng mục | Giá trị | Nguồn |
| --- | --- | --- |
| Payment | `http://localhost:3002` (đổi bằng `LOCAL_PAYMENT_PORT`) | `docs/ops/local-stack.vi.md` |
| Wallet nhận webhook | `http://wallet:3001/webhooks/payment` (trong mạng compose), chung secret `LOCAL_WEBHOOK_SECRET` | `deploy/compose.services.yml:65-66` |
| Đồng tiền | `VND`, `USD`; số tiền nguyên, `>= 1` | `packages/money/src/money.ts:3-18`; DB `ck_charges_currency`, `ck_charges_amount` (`db/payment/001-init.ts:21-23`) |
| Vòng worker | 500 ms | `services/payment/.env.example` (`WORKER_INTERVAL_MS`) |
| Backoff gửi lại webhook | `1,5,30,120,600` giây | `services/payment/.env.example` (`WEBHOOK_BACKOFF`) |
| Thời gian giữ phản hồi `response=timeout` | 30000 ms | `services/payment/.env.example` (`RESPONSE_TIMEOUT_MS`) |

```bash
P=http://localhost:3002
# Mỗi test dùng Idempotency-Key MỚI và reference MỚI (1..200 ký tự).
```

**Quan sát webhook.** Payment **không có endpoint HTTP** để xem webhook (chỉ có `/charges`, `/settlements`, `/health`; `charges.route.ts:19,~65`, `settlements.route.ts:12`, `health.route.ts:4`). Có ba cách xem; cách và tên cột cần xác nhận khi chạy:
- `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs payment wallet`.
- Truy vấn **chỉ đọc** (`SELECT`) DB `billing_payment`, bảng `charges` và `webhook_events` (ràng buộc `ck_webhook_events_status` tại `db/payment/001-init.ts:50`; cột `status`, `attempts`, `next_attempt_at` suy ra từ `webhook-event.ts` **[Chưa xác minh]** tên cột thật, đọc `db/payment/001-init.ts` khi chạy).
- Dashboard "Billing: vận hành" trên Kibana (`http://localhost:15601`).

**Cách đưa webhook về wallet mà không đổi số dư:** thêm `"metadata":{"tenantId":"acme"}` vào charge. Wallet lấy tenant từ metadata đã ký (`webhooks.controller.ts:62-70`); `reference` không khớp topup nào thì wallet trả `200` với `{"outcome":"UNKNOWN_TOPUP"}` (`apply-payment-result.ts:103`), payment coi là đã giao. Nếu **không** có `metadata.tenantId`, wallet trả `400 INVALID_WEBHOOK` và payment sẽ gửi lại theo backoff rồi `FAILED` (xem PAY-041, PAY-042).

## 2. Luồng nghiệp vụ

1. `POST /charges` (header `Idempotency-Key` bắt buộc, body `amount`, `currency`, `reference`, `metadata` tùy chọn) trả `202` và `status:"PENDING"` (`create-charge.ts`, `views.ts` `toCreatedView`).
2. Worker hoàn tất charge khi đến hạn (`dueAt = now + delay`): `SUCCEEDED`, hoặc `FAILED` với `failureCode` nếu có `fail=<code>` (`charge.ts` `complete`).
3. Khi hoàn tất, payment tạo webhook `charge.succeeded`/`charge.failed`, ký HMAC SHA-256, gửi về wallet; thất bại thì gửi lại theo backoff, hết lượt thì `FAILED` (`webhook-event.ts`, `deliver-due-webhooks.ts`, `http-webhook-sender.ts`).
4. `GET /charges/{id}` xem trạng thái; `GET /settlements?date=YYYY-MM-DD` liệt kê charge đã hoàn tất trong ngày UTC kèm tổng (`get-settlement.ts`).

## 3. Phân loại: manual hay tự động hóa

| Phần | Manual (nên) | Tự động hóa sau | Lý do |
| --- | --- | --- | --- |
| Kịch bản thời gian thực (`delay`, `response=timeout`, retry webhook theo backoff) | **Có** | Có test integration với fake clock (`packages/testing/src/fake-clock.ts`) | Chờ thật lâu, giá trị là quan sát hành vi trên stack thật |
| Webhook `drop` / `duplicate` và hệ quả bên wallet | **Có** | Một phần qua e2e | Cần đối chiếu hai service |
| Validation đầu vào `POST /charges` | Một lượt đầu | Postman Regression (nhóm H) | Rẻ, lặp lại nhiều |
| Idempotency tuần tự | Một lượt đầu | Postman Regression | Xác định được |
| Sao kê (`/settlements`) đúng/khớp | **Có** | Postman Smoke | Cần phán đoán khi đối chiếu số liệu |

## 4. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 4.1 Tạo charge (happy path)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAY-001 | Tạo charge thành công | Payment khỏe (`GET /health`) | `curl -s -i -X POST $P/charges -H 'content-type: application/json' -H 'idempotency-key: qa-pay-001' -d '{"amount":150000,"currency":"VND","reference":"qa-ref-001"}'` | `202`; body có `chargeId`, `reference:"qa-ref-001"`, `amount:150000`, `currency:"VND"`, `status:"PENDING"`, `createdAt` | P1 | S | Luồng 1; `charges.route.ts:19-52`; `views.ts` `toCreatedView` |
| PAY-002 | Charge tự hoàn tất `SUCCEEDED` | Sau PAY-001 | Lặp `GET /charges/{chargeId}` mỗi 1 s | Sau vài giây `status:"SUCCEEDED"` có `completedAt`; không có `failureCode` | P1 | S | Luồng 2; `charge.ts` `complete`; `views.ts` `toChargeView` |
| PAY-003 | Đọc charge không tồn tại | — | `GET $P/charges/does-not-exist` | `404`, `CHARGE_NOT_FOUND` | P2 | R | `errors.ts` (`ChargeNotFoundError`); `get-charge.ts:10` |
| PAY-004 | `metadata` được lưu và trả lại | — | Tạo charge với `"metadata":{"tenantId":"acme","orderNo":"A1"}`, rồi `GET /charges/{id}` | `metadata` xuất hiện đúng ở `GET /charges/{id}` (khóa đã sắp xếp) | P2 | R | `README.md` (Payment simulator); `metadata.ts` `parseMetadata`; `views.ts` |
| PAY-005 | Charge `USD` | — | `{"amount":500,"currency":"USD","reference":"qa-ref-005"}` | `202`, `currency:"USD"` | P3 | R | `money.ts:4` |

### 4.2 Validation đầu vào `POST /charges`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAY-010 | Thiếu `Idempotency-Key` | — | `POST /charges` không header | `400`, `MISSING_IDEMPOTENCY_KEY` | P1 | R | `charges.route.ts:20-25` |
| PAY-011 | Key có khoảng trắng đầu/cuối | — | `idempotency-key: ' k1 '` | `400`, `INVALID_IDEMPOTENCY_KEY` | P2 | R | `charges.route.ts:26-31` |
| PAY-012 | Key quá dài | — | Key 256 ký tự | `400`, `INVALID_IDEMPOTENCY_KEY` (giới hạn 255) | P2 | R | `charges.route.ts:15,32-37` |
| PAY-013 | Body không phải object | — | body `[]` hoặc `"x"` | `400`, `INVALID_REQUEST` | P2 | R | `charges.route.ts:39-41` |
| PAY-014 | `amount` sai kiểu | — | `{"amount":"100","currency":"VND","reference":"r"}`; thiếu `amount` | `400`, `INVALID_REQUEST` ("amount must be a number") | P2 | R | `charges.route.ts:43-45` |
| PAY-015 | `currency`/`reference` sai kiểu | — | `currency:123`; `reference:123` | `400`, `INVALID_REQUEST` | P2 | R | `charges.route.ts:46-51` |
| PAY-016 | Số tiền bằng 0 hoặc âm | — | `amount:0`; `amount:-5` | `400`, `INVALID_REQUEST` ("amount must be at least 1 minor unit") | P1 | R | `charge.ts` (`isPositive`); `errors.ts` (`InvalidChargeError`) |
| PAY-017 | Số tiền thập phân | — | `amount:100.5` | `400`, `INVALID_REQUEST` | P1 | R | `money.ts:13-15`; `errors.ts` (`InvalidMoneyError`) |
| PAY-018 | Đồng tiền không hỗ trợ | — | `currency:"EUR"` | `400`, `INVALID_REQUEST` | P2 | R | `money.ts:16-18` |
| PAY-019 | `reference` rỗng hoặc quá dài | — | `reference:"  "`; `reference` 201 ký tự | `400`, `INVALID_REQUEST` ("reference must be 1..200 characters") | P2 | R | `charge.ts` (`MAX_REFERENCE_LENGTH=200`, `charge.ts:6`) |
| PAY-020 | `metadata` không hợp lệ | — | `metadata:[]`; 11 khóa; khóa `"1bad"`; giá trị không phải chuỗi hoặc dài 201 ký tự | `400`, `INVALID_REQUEST` | P2 | R | `metadata.ts` (tối đa 10 khóa, khóa `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, giá trị ≤ 200) |
| PAY-021 | JSON hỏng / body rỗng | — | `-d '{bad'` | `400`, `INVALID_REQUEST` (lỗi 4xx của Fastify) | P3 | R | `errors.ts` `mapError` (nhánh `statusCode`) |
| PAY-022 | Route không tồn tại | — | `GET $P/nope` | `404`, `NOT_FOUND` | P3 | R | `errors.ts` `setNotFoundHandler` |

### 4.3 Idempotency của charge

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAY-030 | Gửi lại cùng key và nội dung trả đúng kết quả cũ | — | Gửi PAY-001 hai lần cùng key | Cả hai `202`, **cùng `chargeId`**; `GET /settlements` (sau khi hoàn tất) chỉ có **một** charge | P1 | S | `create-charge.ts` (`replay`) |
| PAY-031 | Cùng key, khác nội dung | Sau PAY-030 | Cùng key, đổi `amount` hoặc `reference` hoặc `X-Simulate` | `422`, `IDEMPOTENCY_KEY_REUSED` | P1 | R | `create-charge.ts` (`requestHash` gồm amount, currency, reference, scenario, metadata); `errors.ts` |
| PAY-032 | Thứ tự token trong `X-Simulate` không đổi hash | Sau khi tạo với `X-Simulate: fail=a,delay=2` | Gửi lại cùng key với `X-Simulate: delay=2,fail=a` | `202`, cùng `chargeId` (không `422`) | P3 | R | `create-charge.ts` (comment "băm nội dung đã chuẩn hóa") |
| PAY-033 | Gửi đồng thời cùng key | — | 5 request song song cùng key (`curl ... &` rồi `wait`) | Mọi phản hồi `202` cùng `chargeId`; chỉ 1 charge | P1 | R | `create-charge.ts` (xử lý `DuplicateKeyError`) |

### 4.4 Kịch bản `X-Simulate`

Định dạng: danh sách `khóa=giá trị` ngăn bởi dấu phẩy: `fail`, `delay`, `webhook`, `response` (`README.md`; `scenario.ts`). Khóa lạ, khóa lặp, token sai dạng đều bị từ chối, không đoán (`scenario.ts`).

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| SIM-001 | `fail=<code>` làm charge `FAILED` | — | Tạo charge với `-H 'x-simulate: fail=card_declined'`; theo dõi `GET /charges/{id}` | `status:"FAILED"`, `failureCode:"card_declined"`, có `completedAt` | P1 | S | `scenario.ts`; `charge.ts` `complete` |
| SIM-002 | `fail` sai định dạng | — | `fail=Card-Declined`; `fail=` (rỗng); mã dài 65 ký tự | `400`, `INVALID_SIMULATE` | P2 | R | `scenario.ts` (`^[a-z][a-z0-9_]{0,63}$`); `errors.ts` |
| SIM-003 | `delay=<giây>` trì hoãn hoàn tất | — | `x-simulate: delay=10`; đọc `GET /charges/{id}` ngay và sau 10+ giây | Ngay sau khi tạo `PENDING`; hoàn tất sau ≈ 10 giây (cộng ≤ vòng worker 500 ms) | P1 | R | `charge.ts` (`dueAt`); `scenario.ts` |
| SIM-004 | `delay` ngoài miền | — | `delay=0`; `delay=3601`; `delay=1.5`; `delay=abc` | `400`, `INVALID_SIMULATE` (cho phép nguyên `1..3600`) | P2 | R | `scenario.ts` (`MAX_DELAY_SECONDS=3600`, `DELAY`) |
| SIM-005 | `response=timeout` giữ phản hồi | — | `x-simulate: response=timeout`; đo thời gian bằng `curl -w '%{time_total}'` | Phản hồi `202` đến sau ≈ 30 s (`RESPONSE_TIMEOUT_MS`); charge **đã được tạo** (`GET /charges/{id}` thấy được; client dùng timeout ngắn thấy lỗi nhưng charge vẫn có) | P1 | R | `charges.route.ts:54-55`; `create-charge.ts` |
| SIM-006 | `response=timeout`: retry cùng key không bị giữ lần nữa | Sau SIM-005 | Gửi lại cùng key và cùng `x-simulate` | Phản hồi `202` đến **ngay**, cùng `chargeId` | P1 | R | `create-charge.ts` (`responseTimeout` chỉ true ở lần đầu: "lối thoát") |
| SIM-007 | `webhook=drop` | Charge kèm `metadata.tenantId=acme` | `x-simulate: webhook=drop`; chờ hoàn tất | Charge `SUCCEEDED` nhưng **wallet không nhận** webhook (không có log nhận ở wallet; `webhook_events` **[Chưa xác minh]** hành vi chính xác của `drop`: không tạo hay không gửi; đọc `deliver-due-webhooks.ts` phần còn lại và ghi lại) | P1 | R | `scenario.ts` (`webhook: 'drop'`); câu hỏi mục 7 |
| SIM-008 | `webhook=duplicate` | Charge kèm `metadata.tenantId=acme`, `reference` không khớp topup | `x-simulate: webhook=duplicate`; chờ | Wallet nhận **hai** lần cùng `eventId`; lần hai trả `200` với `outcome:"DUPLICATE"` (không tác dụng phụ) | P1 | R | `webhook-event.ts` (`sendTwice`); `apply-payment-result.ts:76` (`DUPLICATE`) |
| SIM-009 | `webhook` giá trị lạ | — | `webhook=normal`; `webhook=x` | `400`, `INVALID_SIMULATE` (chỉ nhận `drop`/`duplicate`) | P3 | R | `scenario.ts` |
| SIM-010 | `response` giá trị lạ | — | `response=slow` | `400`, `INVALID_SIMULATE` | P3 | R | `scenario.ts` |
| SIM-011 | Khóa lạ / khóa lặp / token thiếu `=` | — | `foo=bar`; `fail=a,fail=b`; `fail` | `400`, `INVALID_SIMULATE` | P2 | R | `scenario.ts` (`unknown key`, `duplicate key`, `malformed token`) |
| SIM-012 | Kết hợp nhiều khóa | Charge kèm metadata tenant | `x-simulate: fail=insufficient_funds,delay=3,webhook=duplicate` | `202`; sau ≈ 3 s: `FAILED`, `failureCode:"insufficient_funds"`; webhook `charge.failed` gửi 2 lần | P2 | R | `scenario.ts`; `webhook-event.ts` |

### 4.5 Webhook: giao và gửi lại

Điều kiện chung: charge kèm `"metadata":{"tenantId":"acme"}` và `reference` **không** khớp topup (wallet sẽ trả `200 UNKNOWN_TOPUP`).

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| PAY-040 | Webhook được giao thành công | Wallet khỏe | Tạo charge, chờ hoàn tất; xem log wallet và `webhook_events` | Wallet log nhận webhook; sự kiện `DELIVERED`, `attempts:1` | P1 | S | Luồng 3; `deliver-due-webhooks.ts`; `http-webhook-sender.ts:23-45` |
| PAY-041 | Gửi lại khi wallet từ chối | Charge **không** có `metadata.tenantId` (wallet trả `400 INVALID_WEBHOOK`) | Tạo charge, chờ hoàn tất, quan sát lịch gửi lại | Payment gửi lại theo backoff `1,5,30,120,600` s (khoảng cách xấp xỉ); hết 5 lần retry thì `FAILED` và giữ lại điều tra (tổng ≈ 756 s ≈ 12,6 phút) | P2 | R | `webhook-event.ts` `recordFailure`; `webhooks.controller.ts:62-70`; `services/payment/.env.example` |
| PAY-042 | Gửi lại khi wallet tạm dừng | Được phép tạm dừng (đã xác nhận cho LED-008; xác nhận lại cho wallet) | `docker compose ... stop wallet`; tạo charge; chờ vài lần retry; `start wallet` | Sau khi wallet lên, một lần retry kế tiếp giao thành công (`DELIVERED`) | P1 | R | `webhook-event.ts`; câu hỏi mục 7 |
| PAY-043 | Chữ ký gửi đi hợp lệ | Wallet khỏe | Xem PAY-040 | Wallet **không** trả `401 INVALID_SIGNATURE` cho webhook thật | P1 | S | `http-webhook-sender.ts:26-31` (`signWebhook`); `webhook.ts` |
| PAY-044 | Webhook sai chữ ký bị từ chối (đầu wallet) | — | Xem `WHK-001`, `WHK-002` ở `01-manual-wallet-core.md` | `401 INVALID_SIGNATURE` | P1 | R | `webhooks.controller.ts:42-52` |

### 4.6 Sao kê `/settlements`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| STL-001 | Sao kê ngày hôm nay (UTC) | Đã có charge `SUCCEEDED` và `FAILED` hôm nay | `curl -s "$P/settlements?date=$(date -u +%F)"` | `200`; `{date, items:[...], nextCursor, totals:[...]}`; mỗi item có `chargeId`, `reference`, `amount`, `currency`, `status` (chỉ `SUCCEEDED`/`FAILED`), `completedAt`; **không** có charge `PENDING` | P1 | S | `get-settlement.ts:28-48` |
| STL-002 | Tổng khớp danh sách | Sau STL-001 | Cộng `amount` các item `SUCCEEDED` theo `currency`, so với `totals` | Khớp **[Chưa xác minh]** cấu trúc chi tiết của `totals` (đọc `SettlementTotal` trong `ports.ts` khi chạy) | P1 | S | `get-settlement.ts` (`charges.totals`) |
| STL-003 | Tính theo ngày UTC | Charge hoàn tất gần nửa đêm UTC | So sánh `completedAt` với `date` | Charge nằm đúng ngày theo `completedAt` UTC (khoảng `[00:00, 24:00)`) | P2 | R | `get-settlement.ts:81-85` |
| STL-004 | `date` thiếu/sai định dạng | — | Không `date`; `date=2026/10/13`; `date=13-10-2026` | `400`, `INVALID_QUERY` ("date must be formatted as YYYY-MM-DD") | P1 | R | `get-settlement.ts:50-53` |
| STL-005 | `date` không phải ngày lịch | — | `date=2026-02-30`; `date=2026-13-01` | `400`, `INVALID_QUERY` ("not a valid calendar date") | P2 | R | `get-settlement.ts:54-57` |
| STL-006 | `date` trong tương lai | — | `date=` ngày mai (UTC) | `400`, `INVALID_QUERY` ("must not be in the future") | P1 | R | `get-settlement.ts:58-61` |
| STL-007 | Ngày không có giao dịch | — | `date=2000-01-01` | `200`, `items:[]`, `nextCursor:null`; `totals` có thể rỗng | P2 | R | `get-settlement.ts` |
| STL-008 | `limit` hợp lệ/không hợp lệ | Có ≥ 3 charge hoàn tất | `limit=1`; rồi `limit=0`, `1001`, `abc`, `1.5` | `limit=1`: một item; các giá trị còn lại `400 INVALID_QUERY` (mặc định 500, tối đa 1000) | P2 | R | `get-settlement.ts:12-13,62-67`; `settlements.route.ts:16-17` |
| STL-009 | Phân trang bằng cursor | Có ≥ 3 charge hoàn tất | `limit=1`, rồi dùng `nextCursor` | Mỗi trang 1 item, không trùng/khuyết, trang cuối `nextCursor:null` | P2 | R | `get-settlement.ts` (`encodeCursor`/`decodeCursor`) |
| STL-010 | Cursor hỏng | — | `cursor=abc`; `cursor=` base64url của JSON sai dạng | `400`, `INVALID_QUERY` ("cursor is invalid") | P2 | R | `get-settlement.ts:69-87` |
| STL-011 | `metadata` hiện trong sao kê | Charge có metadata | `GET /settlements` | Item có `metadata` tương ứng | P3 | R | `get-settlement.ts` (`SettlementItem.metadata`); `README.md` |

### 4.7 Health

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| HLT-001 | Payment khỏe | — | `GET $P/health` | `200`, `{"status":"ok","service":"payment"}` | P1 | S | `health.route.ts:4` |

## 5. Bộ Smoke đề xuất

`HLT-001`, `PAY-001`, `PAY-002`, `PAY-030`, `SIM-001`, `PAY-040`, `PAY-043`, `STL-001`, `STL-002`.

## 6. Kết quả thực thi (điền khi chạy)

| ID | Ngày | Người test | Kết quả (Pass/Fail/Blocked) | Giá trị thực tế khi khác mong đợi | Defect |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 7. Câu hỏi còn mở (riêng nhóm này)

1. **`webhook=drop`** (SIM-007): hành vi chính xác là không tạo event hay tạo rồi không gửi? Tôi chưa đọc hết `deliver-due-webhooks.ts`/`complete-due-charges.ts`; nên đọc nốt trước khi chạy, hoặc ghi nhận khi chạy.
2. **Cách quan sát webhook** (PAY-040 trở đi): dùng log, truy vấn SQL chỉ đọc, hay Kibana? Bạn có sẵn công cụ truy vấn SQL Server (cổng `LOCAL_SQL_PORT=11433`, user `sa`) không?
3. **PAY-042** cần tạm dừng container `wallet`: được phép như đã cho phép với `payment` không?
4. **Tên cột bảng `webhook_events`/`charges`**: xác nhận khi chạy lần đầu (chưa đọc `db/payment/001-init.ts` đủ).
