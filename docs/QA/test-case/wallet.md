# Test case: Wallet (ví, nạp tiền, sổ cái)

Phạm vi: tạo ví, nạp tiền, idempotency của nạp tiền, sổ cái, cô lập tenant, webhook nhận vào. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md). Ví dụ lệnh dùng `W=http://localhost:3001` và `H` như ở tài liệu đó.

Wallet chỉ gọi payment **không kèm `X-Simulate`**. Các kịch bản lỗi của payment (`fail=`, `delay=`, `webhook=drop`...) kiểm ở [`payment-simulator.md`](payment-simulator.md), không qua `POST /topups` của wallet.

## 1. Luồng nghiệp vụ và trạng thái

1. `POST /wallets` tạo ví theo (tenant, customer, currency): lần đầu `201`, gọi lại cùng đồng tiền `200`, khác đồng tiền `409 WALLET_CURRENCY_CONFLICT`.
2. `POST /topups` (header `Idempotency-Key` bắt buộc) tạo topup `REQUESTED` và trả `202`.
3. Wallet gửi charge sang payment; topup chuyển `PENDING` rồi payment gửi webhook về wallet; thành công thì `SUCCEEDED` và ghi sổ cái (cộng ví, trừ tài khoản hệ thống GATEWAY), thất bại thì `FAILED`.
4. Topup `REQUESTED`/`PENDING` có thể `SUCCEEDED` hoặc `FAILED`; topup `FAILED` do `PAYMENT_UNAVAILABLE` vẫn có thể thành `SUCCEEDED` nếu webhook thành công đến muộn.
5. Giới hạn: số tiền một lần nạp `1..1_000_000_000_000` đơn vị nhỏ nhất.

## 2. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất (tiền/đúng-sai), **P2** quan trọng, **P3** phụ. 

### 2.1 Tạo ví

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| WLT-001 | Tạo ví mới thành công | Stack lên; customer `qa-c001` chưa có ví ở tenant `acme` | `curl -s -i -X POST $W/wallets $H -d '{"currency":"VND"}'` | `201`; body có `customerId:"qa-c001"`, `currency:"VND"`, `balance:0`, `createdAt` (ISO) | P1 | S |
| WLT-002 | Tạo ví lặp lại cùng đồng tiền là idempotent | Sau WLT-001 | Gọi lại đúng lệnh WLT-001 | `200` (không phải `201`); cùng `createdAt`, `balance` không đổi | P1 | R |
| WLT-003 | Tạo ví khác đồng tiền bị từ chối | Sau WLT-001 | `POST /wallets` cùng customer, `{"currency":"USD"}` | `409`, `error.code = WALLET_CURRENCY_CONFLICT`; ví cũ vẫn `VND` | P1 | R |
| WLT-004 | Đồng tiền không hỗ trợ | Customer mới | `POST /wallets` với `{"currency":"EUR"}` | `400`, `INVALID_REQUEST` | P2 | R |
| WLT-005 | Body không phải JSON object | — | `POST /wallets` với body `[]` và body `"abc"` | `400`, `INVALID_REQUEST` | P2 | R |
| WLT-006 | `currency` sai kiểu | — | `POST /wallets` với `{"currency":123}` và `{}` | `400`, `INVALID_REQUEST` ("currency must be a string") | P2 | R |
| WLT-007 | Thiếu tenant | — | Bỏ header `x-tenant-id` | `400`, `MISSING_TENANT` | P1 | R |
| WLT-008 | Tenant lạ | — | `x-tenant-id: zzz` (hợp lệ về định dạng, không có trong `LOCAL_TENANTS`) | `403`, `UNKNOWN_TENANT` | P1 | R |
| WLT-009 | Thiếu customer | — | Bỏ `x-customer-id` (hoặc để rỗng/khoảng trắng) | `400`, `MISSING_CUSTOMER` | P2 | R |
| WLT-010 | Customer id sai định dạng | — | `x-customer-id: "bad id!"`; `x-customer-id` dài 65 ký tự | `400`, `INVALID_REQUEST` | P2 | R |
| WLT-011 | Tenant sai định dạng | — | `x-tenant-id: ACME` (chữ hoa) | `403`, `UNKNOWN_TENANT` | P3 | R |
| WLT-012 | Đọc ví | Sau WLT-001 | `curl -s $W/wallet $H` | `200`; cùng nội dung WLT-001; `balance:0` | P1 | S |
| WLT-013 | Đọc ví chưa tạo | Customer chưa có ví | `GET /wallet` | `404`, `WALLET_NOT_FOUND` | P2 | R |

### 2.2 Nạp tiền (happy path và trạng thái)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| TOP-001 | **Hành trình nạp tiền thành công end-to-end** | Ví `VND` `qa-c001` có `balance:0`; payment và wallet khỏe | (1) `curl -s -i -X POST $W/topups $H -H 'idempotency-key: qa-top-001' -d '{"amount":150000}'`; (2) ghi `topupId`; (3) lặp `GET /topups/{topupId}` mỗi 1-2 s đến khi `status` là `SUCCEEDED`; (4) `GET /wallet`; (5) `GET /wallet/entries` | (1) `202`, body `status:"REQUESTED"`, `amount:150000`, `currency:"VND"`; (3) `status` chuyển `SUCCEEDED`, có `completedAt`; (4) `balance:150000`; (5) có **đúng 1** entry mới có `amount` **dương 150000** (`businessKey` là `topup:<topupId>`; ghi lại dấu thực tế của số tiền trong entry khi chạy lần đầu) | P1 | S |
| TOP-002 | Không cộng tiền khi chưa có webhook | Ví số dư 0 | Gọi `POST /topups` rồi **ngay lập tức** `GET /wallet` (trước khi topup xong) | Có thể thấy `balance:0` khi topup còn `REQUESTED`/`PENDING`; chỉ tăng sau `SUCCEEDED` | P2 | R |
| TOP-003 | Tra cứu topup | Sau TOP-001 | `GET /topups/{topupId}` | `200`; `topupId`, `status`, `amount`, `currency`, `createdAt`; `failureCode` chỉ có khi thất bại | P1 | S |
| TOP-004 | Topup không tồn tại | — | `GET /topups/does-not-exist` | `404`, `TOPUP_NOT_FOUND` | P2 | R |
| TOP-005 | Topup của khách khác không tra cứu được | Topup của `qa-c001` | `GET /topups/{id}` với `x-customer-id: qa-c999` (cùng tenant) | `404` `TOPUP_NOT_FOUND` | P1 | R |
| TOP-006 | Số tiền tối thiểu | Ví `VND` | `POST /topups` với `{"amount":1}` | `202` và nạp thành công như TOP-001, số dư +1 | P2 | R |
| TOP-007 | Số tiền bằng 0 | Ví `VND` | `POST /topups` với `{"amount":0}` | `400`, `INVALID_REQUEST` ("amount must be at least 1 minor unit") | P1 | R |
| TOP-008 | Số tiền âm | Ví `VND` | `{"amount":-1000}` | `400`, `INVALID_REQUEST` | P1 | R |
| TOP-009 | Số tiền vượt trần | Ví `VND` | `{"amount":1000000000001}` | `400`, `INVALID_REQUEST` ("must not exceed 1000000000000") | P1 | R |
| TOP-010 | Số tiền đúng trần | Ví `VND` (customer mới) | `{"amount":1000000000000}` | `202` (chấp nhận); **cẩn thận số dư hiển thị**; số này nằm trong phạm vi số nguyên an toàn của JS | P3 | R |
| TOP-011 | Số tiền thập phân | Ví `VND` | `{"amount":100.5}` | `400`, `INVALID_REQUEST` (không phải số nguyên an toàn) | P1 | R |
| TOP-012 | `amount` sai kiểu | Ví `VND` | `{"amount":"1000"}`; `{}`; `{"amount":null}` | `400`, `INVALID_REQUEST` ("amount must be a number") | P2 | R |
| TOP-013 | Body không phải object | Ví `VND` | body `[]` | `400`, `INVALID_REQUEST` | P3 | R |
| TOP-014 | Nạp vào ví chưa tồn tại | Customer chưa có ví | `POST /topups` với key mới | `404`, `WALLET_NOT_FOUND` | P1 | R |
| TOP-015 | Tiền nạp theo đồng tiền của ví | Ví `USD` (customer mới) | `POST /topups` `{"amount":5000}` | Topup có `currency:"USD"`, không nhận currency từ body (body chỉ có `amount`) | P2 | R |

### 2.3 Idempotency của nạp tiền

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| IDM-001 | Thiếu `Idempotency-Key` | Ví có sẵn | `POST /topups` không header `idempotency-key` | `400`, `MISSING_IDEMPOTENCY_KEY` | P1 | R |
| IDM-002 | Key sai định dạng | Ví có sẵn | Key có khoảng trắng đầu/cuối (`' k1 '`); key dài 256 ký tự | `400`, `INVALID_IDEMPOTENCY_KEY` | P2 | R |
| IDM-003 | Gửi lại cùng key và cùng nội dung trả lại đúng kết quả cũ | Ví có sẵn | Gửi `POST /topups` key `qa-idm-003`, `{"amount":1000}` hai lần liên tiếp | Cả hai lần `202`, **cùng `topupId`**; sau khi xong, số dư chỉ tăng **một lần** (1000) | P1 | S |
| IDM-004 | Cùng key, khác số tiền | Sau IDM-003 | Gửi key `qa-idm-003` với `{"amount":2000}` | `422`, `IDEMPOTENCY_KEY_REUSED`; không tạo topup mới | P1 | R |
| IDM-005 | Key trùng ở khách khác không va chạm | Hai ví `qa-c001`, `qa-c002` (cùng tenant) | Cùng key `shared-key` cho hai khách | Hai topup độc lập, hai `topupId` khác nhau | P1 | R |
| IDM-006 | Gửi đồng thời cùng key | Ví có sẵn | Bắn 5 request song song cùng key và nội dung (ví dụ `for i in 1 2 3 4 5; do curl ... & done; wait`) | Mọi phản hồi `202` cùng `topupId`; sau khi xong số dư tăng **đúng 1 lần** | P1 | R |

### 2.4 Sổ cái và danh sách entries

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| LED-001 | Liệt kê entries mặc định | Ví đã có ≥ 1 topup thành công | `GET /wallet/entries` | `200`; `{items:[...], nextCursor:...}`; mỗi item có `entryId`, `transactionId`, `businessKey`, `amount`, `createdAt` | P1 | S |
| LED-002 | Số dư khớp tổng entries | Ví có ≥ 2 topup thành công | Cộng `amount` của mọi entry (phân trang đến hết) so với `GET /wallet` `balance` | Hai số bằng nhau | P1 | S |
| LED-003 | Phân trang | Ví có ≥ 3 entries | `GET /wallet/entries?limit=1`, rồi dùng `nextCursor` cho trang sau | Mỗi trang 1 item; `nextCursor` là `null` ở trang cuối; không trùng/khuyết entry | P2 | R |
| LED-004 | `limit` không hợp lệ | Ví có sẵn | `limit=0`, `limit=1001`, `limit=abc`, `limit=1.5` | `400`, `INVALID_QUERY` | P2 | R |
| LED-005 | `cursor` không hợp lệ | Ví có sẵn | `cursor=abc` | `400`, `INVALID_QUERY` ("cursor is invalid") | P3 | R |
| LED-006 | `limit`/`cursor` lặp tham số | Ví có sẵn | `?limit=1&limit=2` | `400`, `INVALID_QUERY` | P3 | R |
| LED-007 | Entries của ví chưa tạo | Customer chưa có ví | `GET /wallet/entries` | `404`, `WALLET_NOT_FOUND` | P2 | R |
| LED-008 | Topup thất bại do payment không khả dụng không để lại entry | Có thể tạm dừng `payment`; ví `VND` số dư biết trước | (1) `docker compose -f deploy/compose.local.yml --env-file deploy/.env stop payment`; (2) `POST /topups` key mới; (3) theo dõi `GET /topups/{id}` ≈ 13 phút; (4) `start payment` | Topup ở `REQUESTED` và được thử lại theo backoff `1,5,30,120,600` s; sau lần thất bại thứ 6 chuyển `FAILED`, `failureCode:"PAYMENT_UNAVAILABLE"`, `completedAt` có giá trị (tổng ≈ 756 s); số dư không đổi; không có entry mới. Nếu dừng ngắn rồi `start payment` sớm: topup tự `PENDING`→`SUCCEEDED` | P2 | R |

### 2.5 Cô lập tenant

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| TEN-001 | Cùng customer id ở hai tenant là hai ví độc lập | Tenant `acme` và `beta` | Tạo ví `qa-ten1` ở cả hai; nạp 1000 ở `acme`, 2000 ở `beta` | `GET /wallet` ở `acme` `balance:1000`; ở `beta` `balance:2000` | P1 | S |
| TEN-002 | Topup không "rò" sang tenant khác | Sau TEN-001 | `GET /topups/{id của acme}` với header `x-tenant-id: beta` | `404`, `TOPUP_NOT_FOUND` | P1 | R |
| TEN-003 | Entries không lẫn giữa tenant | Sau TEN-001 | `GET /wallet/entries` ở `beta` | Chỉ thấy entry 2000 của `beta` | P1 | R |
| TEN-004 | Idempotency key chỉ có nghĩa trong một tenant | Hai tenant | Dùng cùng `Idempotency-Key` và cùng customer id ở `acme` và `beta` | Hai topup độc lập, cùng thành công | P2 | R |

### 2.6 Webhook nhận vào (kiểm tra từ chối; không cần tính chữ ký)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| WHK-001 | Webhook không chữ ký bị từ chối | Wallet khỏe | `curl -s -i -X POST $W/webhooks/payment -H 'content-type: application/json' -d '{}'` | `401`, `INVALID_SIGNATURE` | P1 | R |
| WHK-002 | Chữ ký sai bị từ chối | Wallet khỏe | Thêm `-H 'x-signature: abc'` | `401`, `INVALID_SIGNATURE`; thông điệp không lộ chữ ký/secret | P1 | R |
| WHK-003 | Webhook hợp lệ do QA tự ký: tenant lạ/không xác định | Có `LOCAL_WEBHOOK_SECRET` (trong `deploy/.env`) | Tạo body JSON hợp lệ (xem mục 2.7), ký bằng lệnh ở mục 2.7, `POST /webhooks/payment` | Với `metadata.tenantId` thiếu/lạ: `400 INVALID_WEBHOOK` ("does not identify a known tenant"); với tenant `acme` và `reference` không khớp topup: `200 {"outcome":"UNKNOWN_TOPUP"}` | P1 | R |

### 2.7 Webhook ký tay

Quy tắc ký: header `x-signature: t=<unix giây>,v1=<hex HMAC-SHA256 của "<t>.<body thô>" bằng secret>`; lệch thời gian quá 300 s bị từ chối.

```bash
SECRET='<LOCAL_WEBHOOK_SECRET trong deploy/.env>'   # KHÔNG commit, không dán vào tài liệu
BODY='{"eventId":"qa-evt-1","type":"charge.succeeded","createdAt":"2026-10-13T00:00:00Z","data":{"chargeId":"qa-ch-1","reference":"qa-unknown-topup","amount":1000,"currency":"VND","status":"SUCCEEDED","completedAt":"2026-10-13T00:00:00Z","metadata":{"tenantId":"acme"}}}'
T=$(date +%s)
SIG="t=$T,v1=$(printf '%s.%s' "$T" "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')"
curl -s -i -X POST $W/webhooks/payment -H 'content-type: application/json' -H "x-signature: $SIG" -d "$BODY"
```

Lưu ý: thân gửi đi phải **đúng từng byte** với chuỗi đã ký (`-d "$BODY"`, không để curl/shell đổi nội dung).

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| WHK-004 | Webhook ký đúng, topup không tồn tại | Lệnh mục 2.7 | Chạy nguyên văn | `200`, `{"outcome":"UNKNOWN_TOPUP"}`; số dư mọi ví không đổi | P1 | R |
| WHK-005 | Chữ ký đúng nhưng quá hạn (replay) | Như trên | Dùng `T=$(( $(date +%s) - 600 ))` rồi ký lại | `401`, `INVALID_SIGNATURE` | P1 | R |
| WHK-006 | Sửa thân sau khi ký | Như trên | Đổi `amount` trong thân gửi đi nhưng giữ `SIG` cũ | `401`, `INVALID_SIGNATURE` | P1 | R |
| WHK-007 | Chữ ký đúng nhưng thân sai schema | Ký lại cho thân sai | Thân `{"eventId":"x"}` (thiếu trường) hoặc `charge.succeeded` kèm `status:"FAILED"` | `400`, `INVALID_WEBHOOK` kèm danh sách lỗi | P2 | R |
| WHK-008 | Chữ ký đúng, thân không phải JSON | Ký lại cho thân `not json` | `POST` | `400`, `INVALID_WEBHOOK` ("body is not valid JSON") | P3 | R |
| WHK-009 | Tenant không có trong `metadata` | Ký lại thân bỏ `metadata` | `POST` | `400`, `INVALID_WEBHOOK` ("does not identify a known tenant") | P1 | R |
| WHK-010 | Gửi lại cùng `eventId` | Sau WHK-004 | Ký lại (timestamp mới) và gửi lại cùng thân | `200`, `{"outcome":"DUPLICATE"}`; không tác dụng phụ | P1 | R |
| WHK-011 | Topup khớp nhưng số tiền lệch | Một topup `PENDING` có `reference`=`topupId`, `amount` khác | Gửi webhook với `reference` = `topupId` nhưng `amount` khác | `200`, `{"outcome":"MISMATCH"}`; số dư và topup không đổi | P1 | R |

## 3. Bộ Smoke đề xuất (chạy mỗi lần deploy)

`WLT-001`, `WLT-012`, `TOP-001`, `TOP-003`, `IDM-003`, `LED-001`, `LED-002`, `TEN-001`. Tám case này phủ: tạo ví, nạp tiền end-to-end, idempotency cơ bản, sổ cái khớp số dư, hai tenant.
