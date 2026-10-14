# Test case: Payment simulator

Payment là cổng thanh toán **giả lập**: tạo charge, hoàn tất theo kịch bản `X-Simulate`, gửi webhook về wallet, cung cấp sao kê. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md).

## 1. Chuẩn bị

| Hạng mục | Giá trị |
| --- | --- |
| Payment | `http://localhost:3002` (đổi bằng `LOCAL_PAYMENT_PORT`) |
| Wallet nhận webhook | `http://wallet:3001/webhooks/payment` (trong mạng compose), chung secret `LOCAL_WEBHOOK_SECRET` |
| Đồng tiền | `VND`, `USD`; số tiền nguyên, `>= 1` |
| Chu kỳ xử lý charge của payment | 500 ms |
| Backoff gửi lại webhook | `1,5,30,120,600` giây |
| Thời gian giữ phản hồi `response=timeout` | 30000 ms |

```bash
P=http://localhost:3002
# Mỗi test dùng Idempotency-Key MỚI và reference MỚI (1..200 ký tự).
```

**Quan sát webhook.** Payment không có endpoint HTTP để xem webhook. Có ba cách xem:
- `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs payment wallet`.
- Truy vấn **chỉ đọc** (`SELECT`) DB `billing_payment`, bảng `charges` và `webhook_events`.
- Dashboard "Billing: vận hành" trên Kibana (`http://localhost:15601`).

**Cách đưa webhook về wallet mà không đổi số dư:** thêm `"metadata":{"tenantId":"acme"}` vào charge. Wallet lấy tenant từ metadata đã ký; `reference` không khớp topup nào thì wallet trả `200` với `{"outcome":"UNKNOWN_TOPUP"}` và payment coi là đã giao. Nếu **không** có `metadata.tenantId`, wallet trả `400 INVALID_WEBHOOK` và payment sẽ gửi lại theo backoff rồi `FAILED` (xem PAY-041, PAY-042).

## 2. Luồng nghiệp vụ

1. `POST /charges` (header `Idempotency-Key` bắt buộc, body `amount`, `currency`, `reference`, `metadata` tùy chọn) trả `202` và `status:"PENDING"`.
2. Payment hoàn tất charge khi đến hạn: `SUCCEEDED`, hoặc `FAILED` với `failureCode` nếu có `fail=<code>`.
3. Khi hoàn tất, payment tạo webhook `charge.succeeded`/`charge.failed`, ký HMAC SHA-256, gửi về wallet; thất bại thì gửi lại theo backoff, hết lượt thì `FAILED`.
4. `GET /charges/{id}` xem trạng thái; `GET /settlements?date=YYYY-MM-DD` liệt kê charge đã hoàn tất trong ngày UTC kèm tổng.

## 3. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 3.1 Tạo charge (happy path)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| PAY-001 | Tạo charge thành công | Payment khỏe (`GET /health`) | `curl -s -i -X POST $P/charges -H 'content-type: application/json' -H 'idempotency-key: qa-pay-001' -d '{"amount":150000,"currency":"VND","reference":"qa-ref-001"}'` | `202`; body có `chargeId`, `reference:"qa-ref-001"`, `amount:150000`, `currency:"VND"`, `status:"PENDING"`, `createdAt` | P1 | S |
| PAY-002 | Charge tự hoàn tất `SUCCEEDED` | Sau PAY-001 | Lặp `GET /charges/{chargeId}` mỗi 1 s | Sau vài giây `status:"SUCCEEDED"` có `completedAt`; không có `failureCode` | P1 | S |
| PAY-003 | Đọc charge không tồn tại | — | `GET $P/charges/does-not-exist` | `404`, `CHARGE_NOT_FOUND` | P2 | R |
| PAY-004 | `metadata` được lưu và trả lại | — | Tạo charge với `"metadata":{"tenantId":"acme","orderNo":"A1"}`, rồi `GET /charges/{id}` | `metadata` xuất hiện đúng ở `GET /charges/{id}` (khóa đã sắp xếp) | P2 | R |
| PAY-005 | Charge `USD` | — | `{"amount":500,"currency":"USD","reference":"qa-ref-005"}` | `202`, `currency:"USD"` | P3 | R |

### 3.2 Validation đầu vào `POST /charges`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| PAY-010 | Thiếu `Idempotency-Key` | — | `POST /charges` không header | `400`, `MISSING_IDEMPOTENCY_KEY` | P1 | R |
| PAY-011 | Key có khoảng trắng đầu/cuối | — | `idempotency-key: ' k1 '` | `400`, `INVALID_IDEMPOTENCY_KEY` | P2 | R |
| PAY-012 | Key quá dài | — | Key 256 ký tự | `400`, `INVALID_IDEMPOTENCY_KEY` (giới hạn 255) | P2 | R |
| PAY-013 | Body không phải object | — | body `[]` hoặc `"x"` | `400`, `INVALID_REQUEST` | P2 | R |
| PAY-014 | `amount` sai kiểu | — | `{"amount":"100","currency":"VND","reference":"r"}`; thiếu `amount` | `400`, `INVALID_REQUEST` ("amount must be a number") | P2 | R |
| PAY-015 | `currency`/`reference` sai kiểu | — | `currency:123`; `reference:123` | `400`, `INVALID_REQUEST` | P2 | R |
| PAY-016 | Số tiền bằng 0 hoặc âm | — | `amount:0`; `amount:-5` | `400`, `INVALID_REQUEST` ("amount must be at least 1 minor unit") | P1 | R |
| PAY-017 | Số tiền thập phân | — | `amount:100.5` | `400`, `INVALID_REQUEST` | P1 | R |
| PAY-018 | Đồng tiền không hỗ trợ | — | `currency:"EUR"` | `400`, `INVALID_REQUEST` | P2 | R |
| PAY-019 | `reference` rỗng hoặc quá dài | — | `reference:"  "`; `reference` 201 ký tự | `400`, `INVALID_REQUEST` ("reference must be 1..200 characters") | P2 | R |
| PAY-020 | `metadata` không hợp lệ | — | `metadata:[]`; 11 khóa; khóa `"1bad"`; giá trị không phải chuỗi hoặc dài 201 ký tự | `400`, `INVALID_REQUEST` | P2 | R |
| PAY-021 | JSON hỏng / body rỗng | — | `-d '{bad'` | `400`, `INVALID_REQUEST` (lỗi 4xx của Fastify) | P3 | R |
| PAY-022 | Route không tồn tại | — | `GET $P/nope` | `404`, `NOT_FOUND` | P3 | R |

### 3.3 Idempotency của charge

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| PAY-030 | Gửi lại cùng key và nội dung trả đúng kết quả cũ | — | Gửi PAY-001 hai lần cùng key | Cả hai `202`, **cùng `chargeId`**; `GET /settlements` (sau khi hoàn tất) chỉ có **một** charge | P1 | S |
| PAY-031 | Cùng key, khác nội dung | Sau PAY-030 | Cùng key, đổi `amount` hoặc `reference` hoặc `X-Simulate` | `422`, `IDEMPOTENCY_KEY_REUSED` | P1 | R |
| PAY-032 | Thứ tự token trong `X-Simulate` không đổi hash | Sau khi tạo với `X-Simulate: fail=a,delay=2` | Gửi lại cùng key với `X-Simulate: delay=2,fail=a` | `202`, cùng `chargeId` (không `422`) | P3 | R |
| PAY-033 | Gửi đồng thời cùng key | — | 5 request song song cùng key (`curl ... &` rồi `wait`) | Mọi phản hồi `202` cùng `chargeId`; chỉ 1 charge | P1 | R |

### 3.4 Kịch bản `X-Simulate`

Định dạng: danh sách `khóa=giá trị` ngăn bởi dấu phẩy: `fail`, `delay`, `webhook`, `response`. Khóa lạ, khóa lặp, token sai dạng đều bị từ chối, không đoán.

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| SIM-001 | `fail=<code>` làm charge `FAILED` | — | Tạo charge với `-H 'x-simulate: fail=card_declined'`; theo dõi `GET /charges/{id}` | `status:"FAILED"`, `failureCode:"card_declined"`, có `completedAt` | P1 | S |
| SIM-002 | `fail` sai định dạng | — | `fail=Card-Declined`; `fail=` (rỗng); mã dài 65 ký tự | `400`, `INVALID_SIMULATE` | P2 | R |
| SIM-003 | `delay=<giây>` trì hoãn hoàn tất | — | `x-simulate: delay=10`; đọc `GET /charges/{id}` ngay và sau 10+ giây | Ngay sau khi tạo `PENDING`; hoàn tất sau ≈ 10 giây (cộng ≤ vòng worker 500 ms) | P1 | R |
| SIM-004 | `delay` ngoài miền | — | `delay=0`; `delay=3601`; `delay=1.5`; `delay=abc` | `400`, `INVALID_SIMULATE` (cho phép nguyên `1..3600`) | P2 | R |
| SIM-005 | `response=timeout` giữ phản hồi | — | `x-simulate: response=timeout`; đo thời gian bằng `curl -w '%{time_total}'` | Phản hồi `202` đến sau ≈ 30 s (`RESPONSE_TIMEOUT_MS`); charge **đã được tạo** (`GET /charges/{id}` thấy được; client dùng timeout ngắn thấy lỗi nhưng charge vẫn có) | P1 | R |
| SIM-006 | `response=timeout`: retry cùng key không bị giữ lần nữa | Sau SIM-005 | Gửi lại cùng key và cùng `x-simulate` | Phản hồi `202` đến **ngay**, cùng `chargeId` | P1 | R |
| SIM-007 | `webhook=drop` | Charge kèm `metadata.tenantId=acme` | `x-simulate: webhook=drop`; chờ hoàn tất | Charge `SUCCEEDED` nhưng **wallet không nhận** webhook (không có log nhận ở wallet; ghi lại trong `webhook_events` có bản ghi hay không để biết `drop` là "không tạo" hay "không gửi") | P1 | R |
| SIM-008 | `webhook=duplicate` | Charge kèm `metadata.tenantId=acme`, `reference` không khớp topup | `x-simulate: webhook=duplicate`; chờ | Wallet nhận **hai** lần cùng `eventId`; lần hai trả `200` với `outcome:"DUPLICATE"` (không tác dụng phụ) | P1 | R |
| SIM-009 | `webhook` giá trị lạ | — | `webhook=normal`; `webhook=x` | `400`, `INVALID_SIMULATE` (chỉ nhận `drop`/`duplicate`) | P3 | R |
| SIM-010 | `response` giá trị lạ | — | `response=slow` | `400`, `INVALID_SIMULATE` | P3 | R |
| SIM-011 | Khóa lạ / khóa lặp / token thiếu `=` | — | `foo=bar`; `fail=a,fail=b`; `fail` | `400`, `INVALID_SIMULATE` | P2 | R |
| SIM-012 | Kết hợp nhiều khóa | Charge kèm metadata tenant | `x-simulate: fail=insufficient_funds,delay=3,webhook=duplicate` | `202`; sau ≈ 3 s: `FAILED`, `failureCode:"insufficient_funds"`; webhook `charge.failed` gửi 2 lần | P2 | R |

### 3.5 Webhook: giao và gửi lại

Điều kiện chung: charge kèm `"metadata":{"tenantId":"acme"}` và `reference` **không** khớp topup (wallet sẽ trả `200 UNKNOWN_TOPUP`).

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| PAY-040 | Webhook được giao thành công | Wallet khỏe | Tạo charge, chờ hoàn tất; xem log wallet và `webhook_events` | Wallet log nhận webhook; sự kiện `DELIVERED`, `attempts:1` | P1 | S |
| PAY-041 | Gửi lại khi wallet từ chối | Charge **không** có `metadata.tenantId` (wallet trả `400 INVALID_WEBHOOK`) | Tạo charge, chờ hoàn tất, quan sát lịch gửi lại | Payment gửi lại theo backoff `1,5,30,120,600` s (khoảng cách xấp xỉ); hết 5 lần retry thì `FAILED` và giữ lại điều tra (tổng ≈ 756 s ≈ 12,6 phút) | P2 | R |
| PAY-042 | Gửi lại khi wallet tạm dừng | Có thể tạm dừng `wallet` | `docker compose ... stop wallet`; tạo charge; chờ vài lần retry; `start wallet` | Sau khi wallet lên, một lần retry kế tiếp giao thành công (`DELIVERED`) | P1 | R |
| PAY-043 | Chữ ký gửi đi hợp lệ | Wallet khỏe | Xem PAY-040 | Wallet **không** trả `401 INVALID_SIGNATURE` cho webhook thật | P1 | S |
| PAY-044 | Webhook sai chữ ký bị từ chối (đầu wallet) | — | Xem `WHK-001`, `WHK-002` ở `01-manual-wallet-core.md` | `401 INVALID_SIGNATURE` | P1 | R |

### 3.6 Sao kê `/settlements`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| STL-001 | Sao kê ngày hôm nay (UTC) | Đã có charge `SUCCEEDED` và `FAILED` hôm nay | `curl -s "$P/settlements?date=$(date -u +%F)"` | `200`; `{date, items:[...], nextCursor, totals:[...]}`; mỗi item có `chargeId`, `reference`, `amount`, `currency`, `status` (chỉ `SUCCEEDED`/`FAILED`), `completedAt`; **không** có charge `PENDING` | P1 | S |
| STL-002 | Tổng khớp danh sách | Sau STL-001 | Cộng `amount` các item `SUCCEEDED` theo `currency`, so với `totals` | Khớp; ghi lại cấu trúc `totals` thực tế khi chạy lần đầu | P1 | S |
| STL-003 | Tính theo ngày UTC | Charge hoàn tất gần nửa đêm UTC | So sánh `completedAt` với `date` | Charge nằm đúng ngày theo `completedAt` UTC (khoảng `[00:00, 24:00)`) | P2 | R |
| STL-004 | `date` thiếu/sai định dạng | — | Không `date`; `date=2026/10/13`; `date=13-10-2026` | `400`, `INVALID_QUERY` ("date must be formatted as YYYY-MM-DD") | P1 | R |
| STL-005 | `date` không phải ngày lịch | — | `date=2026-02-30`; `date=2026-13-01` | `400`, `INVALID_QUERY` ("not a valid calendar date") | P2 | R |
| STL-006 | `date` trong tương lai | — | `date=` ngày mai (UTC) | `400`, `INVALID_QUERY` ("must not be in the future") | P1 | R |
| STL-007 | Ngày không có giao dịch | — | `date=2000-01-01` | `200`, `items:[]`, `nextCursor:null`; `totals` có thể rỗng | P2 | R |
| STL-008 | `limit` hợp lệ/không hợp lệ | Có ≥ 3 charge hoàn tất | `limit=1`; rồi `limit=0`, `1001`, `abc`, `1.5` | `limit=1`: một item; các giá trị còn lại `400 INVALID_QUERY` (mặc định 500, tối đa 1000) | P2 | R |
| STL-009 | Phân trang bằng cursor | Có ≥ 3 charge hoàn tất | `limit=1`, rồi dùng `nextCursor` | Mỗi trang 1 item, không trùng/khuyết, trang cuối `nextCursor:null` | P2 | R |
| STL-010 | Cursor hỏng | — | `cursor=abc`; `cursor=` base64url của JSON sai dạng | `400`, `INVALID_QUERY` ("cursor is invalid") | P2 | R |
| STL-011 | `metadata` hiện trong sao kê | Charge có metadata | `GET /settlements` | Item có `metadata` tương ứng | P3 | R |

### 3.7 Health

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| HLT-001 | Payment khỏe | — | `GET $P/health` | `200`, `{"status":"ok","service":"payment"}` | P1 | S |

## 4. Bộ Smoke đề xuất

`HLT-001`, `PAY-001`, `PAY-002`, `PAY-030`, `SIM-001`, `PAY-040`, `PAY-043`, `STL-001`, `STL-002`.
