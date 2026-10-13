# Postman Regression (nhóm H)

> **Giai đoạn 2, nhóm H.** Folder **`Regression`** trong bốn collection Postman: negative và edge case. Cùng tệp, environment, cách chạy và tác dụng phụ với [`07-postman-smoke.md`](07-postman-smoke.md); bản này chỉ liệt kê nội dung Regression.
> **Đã kiểm tra:** JSON hợp lệ, schema collection v2.1.0, script qua `node --check`, biến định nghĩa trước khi dùng. **Chưa chạy** qua Postman/Newman với stack local.
> **Quy tắc đặt kỳ vọng:** mã lỗi (`error.code`) được kiểm **chính xác** khi đã đọc được trong code. Khi mã chưa xác minh, request ghi rõ "(mã chưa xác minh)" và chỉ kiểm **4xx**.

## Environment và biến

File environment: [`postman/billing-local.postman_environment.json`](postman/billing-local.postman_environment.json). Không chứa secret thật.

| Biến | Giá trị mặc định | Ý nghĩa |
| --- | --- | --- |
| `wallet_base_url` | `http://localhost:3001` | Wallet (`LOCAL_WALLET_PORT`, `docs/ops/local-stack.vi.md`) |
| `payment_base_url` | `http://localhost:3002` | Payment (`LOCAL_PAYMENT_PORT`) |
| `tenant_id` / `tenant_id_other` | `acme` / `beta` | Hai tenant mặc định (`LOCAL_TENANTS`, `deploy/compose.services.yml:44`) |
| `tenant_unknown` | `zzz` | Tenant hợp lệ về định dạng nhưng không được phục vụ |
| `actor_id`, `actor_role` | `qa.tester`, `OPS` | Header `x-actor-*` cho `/ops` (QA tự đặt, đã xác nhận) |
| `webhook_secret` | (trống, kiểu **secret**) | `LOCAL_WEBHOOK_SECRET` trong `deploy/.env`; **không commit**; trống thì các request webhook ký tay bị bỏ qua |
| `reconciliation_resolve_enabled` | `false` | `true` mới đóng ca đối soát thật trong Smoke (ghi dữ liệu) |
| `poll_max_attempts`, `poll_interval_ms` | `20`, `1000` | Poll topup/charge/lượt đối soát |

Dự án **không có token/Authorization** (danh tính chỉ qua header gateway; `docs/QA/00-overview.md` mục 3), nên không có biến token. Tên `{{wallet_base_url}}`/`{{payment_base_url}}` thay cho `{{base_url}}` vì hai service ở hai cổng khác nhau.
Các biến chạy (`run`, `cust`, `topup_id`, `charge_id`, `run_id`...) do script tạo và lưu ở **collection variables**; mỗi lần chạy tạo `run` mới nên customer id và `Idempotency-Key` không va chạm giữa các lần chạy.

## Cách chạy

**Postman app:** Import 4 file collection và file environment, chọn environment `billing-local`, mở collection, nhấn **Run**, chọn folder (`Smoke` hoặc `Regression`), **chạy theo thứ tự mặc định**. Các request poll tự lặp lại bằng `postman.setNextRequest`: **chỉ chạy đúng trong Collection Runner/Newman**, không chạy từng request riêng lẻ.

**Newman (CLI)** (chưa chạy trong lúc viết tài liệu này):

```bash
npx newman run docs/QA/postman/wallet/wallet.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  --folder Smoke --env-var webhook_secret="$LOCAL_WEBHOOK_SECRET"
```

Đổi `wallet` thành `payment`, `ops`, `reconciliations`; đổi `--folder Smoke` thành `--folder Regression`. Thứ tự khuyến nghị: payment, wallet, ops, reconciliations (đối soát đọc sao kê payment và dữ liệu wallet).

## Điều kiện và tác dụng phụ

- Stack local đã lên và khỏe (`docs/ops/local-stack.vi.md`). Môi trường là **local**; **không** trỏ vào môi trường dùng chung.
- Mỗi lần chạy **ghi dữ liệu thật** vào DB local: ví, topup, charge, ledger, `ops_actions` (bảng chỉ thêm, **không xóa được**), lượt đối soát. Dữ liệu không được dọn.
- Charge tạo trực tiếp ở payment **không có `metadata.tenantId`**: webhook về wallet bị từ chối (400) và payment gửi lại theo backoff `1,5,30,120,600` s rồi `FAILED` (~12 phút). Không đổi số dư, nhưng có thể làm nhiễu log và metric webhook.
- Lượt đối soát đọc sao kê payment của **cả ngày UTC hiện tại**; chạy gần nửa đêm UTC có thể lệch ngày.

## Cấu trúc

Mỗi collection có folder **Setup** (dựng dữ liệu: ví, topup, charge, lượt đối soát), rồi các folder theo chủ đề. **Phải chạy từ trên xuống** vì các test dựa vào dữ liệu của Setup (ví dụ số dư ví A, ≥ 2 entries, ≥ 2 charge hôm nay).

## Regression: các request

### Wallet

**Setup** (7 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| SETUP-W01 Health + init run | `GET /health` | 200 |  |
| SETUP-W02 Create wallet A | `POST /wallets` | 201 |  |
| SETUP-W03 Create wallet B (second customer) | `POST /wallets` | 201 |  |
| SETUP-W04 Topup A 100000 | `POST /topups` | 202 |  |
| SETUP-W05 Poll topup A1 | `GET /topups/{{topup_a1}}` | 200 | lặp tới trạng thái cuối |
| SETUP-W06 Topup A 2000 (second entry) | `POST /topups` | 202 |  |
| SETUP-W07 Poll topup A2 | `GET /topups/{{topup_a2}}` | 200 | lặp tới trạng thái cuối |

**Wallet / Wallets** (12 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| WLT-002 Re-create same currency returns 200 | `POST /wallets` | 200 |  |
| WLT-003 Re-create with different currency | `POST /wallets` | 409 | WALLET_CURRENCY_CONFLICT |
| WLT-004 Unsupported currency EUR (mã chưa xác minh) | `POST /wallets` | 4xx |  |
| WLT-005 Body is array | `POST /wallets` | 400 | INVALID_REQUEST |
| WLT-006a currency wrong type | `POST /wallets` | 400 | INVALID_REQUEST |
| WLT-006b currency missing | `POST /wallets` | 400 | INVALID_REQUEST |
| WLT-007 Missing tenant | `POST /wallets` | 400 | MISSING_TENANT |
| WLT-008 Unknown tenant | `POST /wallets` | 403 | UNKNOWN_TENANT |
| WLT-009 Missing customer | `POST /wallets` | 400 | MISSING_CUSTOMER |
| WLT-010a Customer id invalid chars | `POST /wallets` | 400 | INVALID_REQUEST |
| WLT-010b Customer id 65 chars | `POST /wallets` | 400 | INVALID_REQUEST |
| WLT-013 Get wallet that does not exist | `GET /wallet` | 404 | WALLET_NOT_FOUND |

**Wallet / Topups** (10 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| TOP-004 Topup not found | `GET /topups/does-not-exist` | 404 | TOPUP_NOT_FOUND |
| TOP-005 Other customer cannot read topup (mã chưa xác minh) | `GET /topups/{{topup_a1}}` | 4xx |  |
| TOP-007 Amount 0 | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-008 Amount negative | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-009 Amount above cap (1e12 + 1) | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-011 Amount decimal | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-012a Amount is string | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-012b Amount missing | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-013 Body is array | `POST /topups` | 400 | INVALID_REQUEST |
| TOP-014 Topup for wallet that does not exist | `POST /topups` | 404 | WALLET_NOT_FOUND |

**Wallet / Idempotency** (7 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| IDM-001 Missing Idempotency-Key | `POST /topups` | 400 | MISSING_IDEMPOTENCY_KEY |
| IDM-002 Idempotency-Key 256 chars | `POST /topups` | 400 | INVALID_IDEMPOTENCY_KEY |
| IDM-003a First topup with key | `POST /topups` | 202 |  |
| IDM-003b Same key and body replays same topup | `POST /topups` | 202 |  |
| IDM-004 Same key, different amount | `POST /topups` | 422 | IDEMPOTENCY_KEY_REUSED |
| IDM-005 Same key for another customer is independent | `POST /topups` | 202 |  |
| IDM-003c Poll topup of IDM-003a to completion | `GET /topups/{{topup_idm}}` | 200 | lặp tới trạng thái cuối |

**Wallet / Ledger** (10 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| LED-004a limit=0 | `GET /wallet/entries?limit=0` | 400 | INVALID_QUERY |
| LED-004b limit=1001 | `GET /wallet/entries?limit=1001` | 400 | INVALID_QUERY |
| LED-004c limit=abc | `GET /wallet/entries?limit=abc` | 400 | INVALID_QUERY |
| LED-004d limit=1.5 | `GET /wallet/entries?limit=1.5` | 400 | INVALID_QUERY |
| LED-005 cursor invalid | `GET /wallet/entries?cursor=abc` | 400 | INVALID_QUERY |
| LED-006 limit repeated | `GET /wallet/entries?limit=1&limit=2` | 400 | INVALID_QUERY |
| LED-007 Entries of missing wallet | `GET /wallet/entries` | 404 | WALLET_NOT_FOUND |
| LED-003a Page 1 (limit=1) | `GET /wallet/entries?limit=1` | 200 |  |
| LED-003b Page 2 using nextCursor | `GET /wallet/entries?limit=1&cursor={{entries_cursor}}` | 200 |  |
| LED-002 Balance equals sum of all topups (102000 + 1000 from IDM-003) | `GET /wallet` | 200 |  |

**Wallet / Tenant isolation** (4 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| TEN-001a Same customer id in other tenant is a separate wallet | `POST /wallets` | 201 |  |
| TEN-001b Other tenant balance is 0 | `GET /wallet` | 200 |  |
| TEN-002 Topup of tenant A not visible in tenant B | `GET /topups/{{topup_a1}}` | 404 | TOPUP_NOT_FOUND |
| TEN-003 Entries are not shared across tenants | `GET /wallet/entries` | 200 |  |

**Wallet / Webhook (inbound)** (10 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| WHK-001 No signature | `POST /webhooks/payment` | 401 | INVALID_SIGNATURE |
| WHK-002 Wrong signature | `POST /webhooks/payment` | 401 | INVALID_SIGNATURE |
| WHK-004 Valid signature, unknown topup | `POST /webhooks/payment` | 200 | outcome=UNKNOWN_TOPUP |
| WHK-005 Expired timestamp (600 s old) | `POST /webhooks/payment` | 401 | INVALID_SIGNATURE |
| WHK-006 Body tampered after signing | `POST /webhooks/payment` | 401 | INVALID_SIGNATURE |
| WHK-007 Valid signature, schema invalid | `POST /webhooks/payment` | 400 | INVALID_WEBHOOK |
| WHK-009 No tenantId in metadata | `POST /webhooks/payment` | 400 | INVALID_WEBHOOK |
| WHK-009b Unknown tenant in metadata | `POST /webhooks/payment` | 400 | INVALID_WEBHOOK |
| WHK-010a First delivery of event | `POST /webhooks/payment` | 200 | outcome=UNKNOWN_TOPUP |
| WHK-010b Same eventId again is a duplicate | `POST /webhooks/payment` | 200 | outcome=DUPLICATE |

### Payment

**Setup** (5 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| SETUP-P01 Health + init run | `GET /health` | 200 |  |
| SETUP-P02 Charge 1 | `POST /charges` | 202 |  |
| SETUP-P03 Charge 2 (fails) | `POST /charges` | 202 |  |
| SETUP-P04 Poll charge 1 | `GET /charges/{{c_s1}}` | 200 | lặp tới trạng thái cuối |
| SETUP-P05 Poll charge 2 | `GET /charges/{{c_s2}}` | 200 | lặp tới trạng thái cuối |

**Charges: validation** (23 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| PAY-010 Missing Idempotency-Key | `POST /charges` | 400 | MISSING_IDEMPOTENCY_KEY |
| PAY-012 Idempotency-Key 256 chars | `POST /charges` | 400 | INVALID_IDEMPOTENCY_KEY |
| PAY-013 Body is array | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-014a amount is string | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-014b amount missing | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-015a currency wrong type | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-015b reference wrong type | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-016a amount 0 | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-016b amount negative | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-017 amount decimal | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-018 currency EUR | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-019a reference blank | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-019b reference 201 chars | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-020a metadata is array | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-020b metadata 11 keys | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-020c metadata bad key | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-020d metadata value not string | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-021 Malformed JSON | `POST /charges` | 400 | INVALID_REQUEST |
| PAY-022 Unknown route | `GET /nope` | 404 | NOT_FOUND |
| PAY-003 Charge not found | `GET /charges/does-not-exist` | 404 | CHARGE_NOT_FOUND |
| PAY-004a Charge with metadata | `POST /charges` | 202 |  |
| PAY-004b Metadata is stored and returned | `GET /charges/{{c_md}}` | 200 |  |
| PAY-005 Charge in USD | `POST /charges` | 202 |  |

**Charges: idempotency** (6 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| PAY-031a First charge with key | `POST /charges` | 202 |  |
| PAY-031b Same key, different amount | `POST /charges` | 422 | IDEMPOTENCY_KEY_REUSED |
| PAY-031c Same key, different reference | `POST /charges` | 422 | IDEMPOTENCY_KEY_REUSED |
| PAY-031d Same key, different X-Simulate | `POST /charges` | 422 | IDEMPOTENCY_KEY_REUSED |
| PAY-032a Charge with X-Simulate fail=a,delay=1 | `POST /charges` | 202 |  |
| PAY-032b Token order does not change the hash (delay=1,fail=a) | `POST /charges` | 202 |  |

**Simulator: X-Simulate** (15 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| SIM-002a fail code uppercase/dash | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-002b fail code too long (65) | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-004a delay=0 | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-004b delay=3601 | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-004c delay=1.5 | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-004d delay=abc | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-009 webhook=x | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-009b webhook=normal | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-010 response=slow | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-011a unknown key | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-011b duplicate key | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-011c token without = | `POST /charges` | 400 | INVALID_SIMULATE |
| SIM-003a Charge with delay=3 | `POST /charges` | 202 |  |
| SIM-003b Still PENDING right after creation | `GET /charges/{{c_dl}}` | 200 |  |
| SIM-003c Poll until SUCCEEDED | `GET /charges/{{c_dl}}` | 200 | lặp tới trạng thái cuối |

**Settlements** (15 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| STL-004a date missing | `GET /settlements` | 400 | INVALID_QUERY |
| STL-004b date wrong format | `GET /settlements?date=2026/10/13` | 400 | INVALID_QUERY |
| STL-004c date dd-mm-yyyy | `GET /settlements?date=13-10-2026` | 400 | INVALID_QUERY |
| STL-005a date 2026-02-30 | `GET /settlements?date=2026-02-30` | 400 | INVALID_QUERY |
| STL-005b date month 13 | `GET /settlements?date=2026-13-01` | 400 | INVALID_QUERY |
| STL-006 date in the future | `GET /settlements?date={{tomorrow}}` | 400 | INVALID_QUERY |
| STL-007 Day without charges | `GET /settlements?date=2000-01-01` | 200 |  |
| STL-008a limit=0 | `GET /settlements?date={{today}}&limit=0` | 400 | INVALID_QUERY |
| STL-008b limit=1001 | `GET /settlements?date={{today}}&limit=1001` | 400 | INVALID_QUERY |
| STL-008c limit=abc | `GET /settlements?date={{today}}&limit=abc` | 400 | INVALID_QUERY |
| STL-008d limit=1.5 | `GET /settlements?date={{today}}&limit=1.5` | 400 | INVALID_QUERY |
| STL-010 cursor invalid | `GET /settlements?date={{today}}&cursor=abc` | 400 | INVALID_QUERY |
| STL-009a Page 1 (limit=1) | `GET /settlements?date={{today}}&limit=1` | 200 |  |
| STL-009b Page 2 via cursor | `GET /settlements?date={{today}}&limit=1&cursor={{stl_cursor}}` | 200 |  |
| STL-011 Metadata appears in settlement | `GET /settlements?date={{today}}&limit=1000` | 200 |  |

### Ops

**Setup** (3 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| SETUP-O01 Init run + create wallet A | `POST /wallets` | 201 |  |
| SETUP-O02 Create wallet B | `POST /wallets` | 201 |  |
| SETUP-O03 Create wallet C | `POST /wallets` | 201 |  |

**Ops / Auth** (9 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| OPS-001 Missing x-actor-id | `GET /ops/actions` | 401 | MISSING_ACTOR |
| OPS-003a Role ADMIN | `GET /ops/actions` | 403 | FORBIDDEN_ROLE |
| OPS-003b Role lowercase ops | `GET /ops/actions` | 403 | FORBIDDEN_ROLE |
| OPS-003c Role missing | `GET /ops/actions` | 403 | FORBIDDEN_ROLE |
| OPS-004 Role "OPS, ADMIN" | `GET /ops/actions` | 403 | FORBIDDEN_ROLE |
| OPS-005 Missing tenant | `GET /ops/actions` | 400 | MISSING_TENANT |
| OPS-006 Unknown tenant | `GET /ops/actions` | 403 | UNKNOWN_TENANT |
| OPS-007 Missing actor and tenant: actor checked first | `GET /ops/actions` | 401 | MISSING_ACTOR |
| OPS-009 Customer headers are not ops identity | `GET /ops/actions` | 401 | MISSING_ACTOR |

**Ops / Freeze** (16 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| FRZ-001 Freeze wallet A | `POST /ops/wallets/{{cust}}/freeze` | 200 |  |
| FRZ-002 Freeze again (new key): no-op | `POST /ops/wallets/{{cust}}/freeze` | 200 |  |
| FRZ-003 Replay freeze with same key returns first result | `POST /ops/wallets/{{cust}}/freeze` | 200 |  |
| FRZ-010 Same key reused for another wallet | `POST /ops/wallets/{{cust_b}}/freeze` | 409 | IDEMPOTENCY_CONFLICT |
| FRZ-004 Unfreeze wallet A | `POST /ops/wallets/{{cust}}/unfreeze` | 200 |  |
| FRZ-005 Unfreeze again: no-op | `POST /ops/wallets/{{cust}}/unfreeze` | 200 |  |
| FRZ-006 Wallet not found | `POST /ops/wallets/{{cust_none}}/freeze` | 404 | WALLET_NOT_FOUND |
| FRZ-007 customerId invalid in path | `POST /ops/wallets/bad!id/freeze` | 400 | INVALID_REQUEST |
| FRZ-008a Empty body | `POST /ops/wallets/{{cust}}/freeze` | 422 | INVALID_OPS_REQUEST |
| FRZ-008b Only reason | `POST /ops/wallets/{{cust}}/freeze` | 422 | INVALID_OPS_REQUEST |
| FRZ-008c Only idempotencyKey | `POST /ops/wallets/{{cust}}/freeze` | 422 | INVALID_OPS_REQUEST |
| FRZ-008d Blank reason | `POST /ops/wallets/{{cust}}/freeze` | 422 | INVALID_OPS_REQUEST |
| FRZ-008e reason 501 chars | `POST /ops/wallets/{{cust}}/freeze` | 422 | INVALID_OPS_REQUEST |
| FRZ-009 Body is array | `POST /ops/wallets/{{cust}}/freeze` | 400 | INVALID_REQUEST |
| OPS-008a Freeze B with body actor "hacker" (ignored) | `POST /ops/wallets/{{cust_b}}/freeze` | 200 |  |
| OPS-008b Action log shows header actor, not body actor | `GET /ops/actions?limit=5` | 200 |  |

**Ops / Adjustments** (21 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| ADJ-011 CREDIT 7000 on a frozen wallet B | `POST /ops/wallets/{{cust_b}}/adjustments` | 201 |  |
| ADJ-011b DEBIT 7000 on frozen wallet B | `POST /ops/wallets/{{cust_b}}/adjustments` | 201 |  |
| ADJ-011c Wallet B balance is 0 | `GET /wallet` | 200 |  |
| REV-009 Reverse CREDIT after it was spent | `POST /ops/transactions/{{tx_b_credit}}/reversals` | 409 | INSUFFICIENT_FUNDS |
| FRZ-004b Unfreeze wallet B | `POST /ops/wallets/{{cust_b}}/unfreeze` | 200 |  |
| ADJ-001 CREDIT 50000 on wallet A | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-002 DEBIT 20000 on wallet A | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-003 DEBIT 40000 exceeds balance (30000) | `POST /ops/wallets/{{cust}}/adjustments` | 409 | INSUFFICIENT_FUNDS |
| ADJ-003b Balance unchanged (30000) | `GET /wallet` | 200 |  |
| ADJ-004 Replay with same key and body | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-005 Same key, different amount | `POST /ops/wallets/{{cust}}/adjustments` | 409 | IDEMPOTENCY_CONFLICT |
| ADJ-006 Another actor, same key and params: first result, no new log | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-007a direction invalid | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-007b direction missing | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-008a amount 0 | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-008b amount negative | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-008c amount decimal | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-008d amount is string | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-009 Wrong currency (USD on VND wallet) | `POST /ops/wallets/{{cust}}/adjustments` | 422 | INVALID_OPS_REQUEST |
| ADJ-010 Wallet not found | `POST /ops/wallets/{{cust_none}}/adjustments` | 404 | WALLET_NOT_FOUND |
| ADJ-013 Wallet A balance is 30000 (replays and errors changed nothing) | `GET /wallet` | 200 |  |

**Ops / Reversals** (10 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| REV-001 Reverse the DEBIT on wallet A | `POST /ops/transactions/{{tx_debit}}/reversals` | 201 |  |
| REV-001b Wallet A balance after reversal | `GET /wallet` | 200 |  |
| REV-002 Reverse again (new key) | `POST /ops/transactions/{{tx_debit}}/reversals` | 409 | ALREADY_REVERSED |
| REV-003 Replay reversal with same key | `POST /ops/transactions/{{tx_debit}}/reversals` | 201 |  |
| REV-007 Reverse a REVERSAL | `POST /ops/transactions/{{tx_rev}}/reversals` | 409 | REVERSAL_NOT_SUPPORTED |
| REV-008 Transaction not found | `POST /ops/transactions/tx_doesnotexist/reversals` | 404 | TRANSACTION_NOT_FOUND |
| REV-006a Topup for wallet C | `POST /topups` | 202 |  |
| REV-006b Poll topup C | `GET /topups/{{topup_c}}` | 200 | lặp tới trạng thái cuối |
| REV-006c Find the topup transaction id | `GET /wallet/entries?limit=10` | 200 |  |
| REV-006 Reverse a TOPUP transaction | `POST /ops/transactions/{{tx_topup_c}}/reversals` | 409 | REVERSAL_NOT_SUPPORTED |

**Ops / Replay** (1 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| RPL-002 Replay for an order that was never paid | `POST /ops/orders/{{order_unknown}}/replay-paid` | 404 | ORDER_NOT_FOUND |

**Ops / Action log** (9 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| LOG-005a limit=0 | `GET /ops/actions?limit=0` | 400 | INVALID_QUERY |
| LOG-005b limit=201 | `GET /ops/actions?limit=201` | 400 | INVALID_QUERY |
| LOG-005c limit=abc | `GET /ops/actions?limit=abc` | 400 | INVALID_QUERY |
| LOG-005d cursor=abc | `GET /ops/actions?cursor=abc` | 400 | INVALID_QUERY |
| LOG-005e cursor=0 | `GET /ops/actions?cursor=0` | 400 | INVALID_QUERY |
| LOG-005f limit repeated | `GET /ops/actions?limit=1&limit=2` | 400 | INVALID_QUERY |
| LOG-004a Page 1 (limit=1) | `GET /ops/actions?limit=1` | 200 |  |
| LOG-004b Page 2 via cursor (older) | `GET /ops/actions?limit=1&cursor={{log_cursor}}` | 200 |  |
| LOG-006 Other tenant does not see this tenant's actions | `GET /ops/actions?limit=200` | 200 |  |

### Reconciliations

**Setup** (3 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| SETUP-R01 Health + init run | `GET /health` | 200 |  |
| SETUP-R02 Start reconciliation for today | `POST /reconciliations` | 202 |  |
| SETUP-R03 Poll run until COMPLETED | `GET /reconciliations/{{run_id}}` | 200 | lặp tới trạng thái cuối |

**Runs: validation** (13 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| REC-010 Missing tenant | `POST /reconciliations` | 400 | MISSING_TENANT |
| REC-011 Unknown tenant | `POST /reconciliations` | 403 | UNKNOWN_TENANT |
| REC-012a date uses slashes | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-012b date dd-mm-yyyy | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-012c date missing | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-012d date is null | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-013a date 2026-02-30 | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-013b date month 13 | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-014 date in the future | `POST /reconciliations` | 422 | INVALID_RECONCILIATION |
| REC-015 Body is array | `POST /reconciliations` | 400 | INVALID_REQUEST |
| REC-004 Re-run creates a new run | `POST /reconciliations` | 202 |  |
| REC-016 Run not found | `GET /reconciliations/does-not-exist` | 404 | RECONCILIATION_NOT_FOUND |
| REC-017 Run of tenant A is not visible to tenant B (mã chưa xác minh) | `GET /reconciliations/{{run_id}}` | 4xx |  |

**Items: query validation** (11 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| REC-003 Items list shape | `GET /reconciliations/{{run_id}}/items` | 200 |  |
| REC-018 caseStatus invalid | `GET /reconciliations/{{run_id}}/items?caseStatus=DONE` | 400 | INVALID_QUERY |
| REC-019a limit=0 | `GET /reconciliations/{{run_id}}/items?limit=0` | 400 | INVALID_QUERY |
| REC-019b limit=501 | `GET /reconciliations/{{run_id}}/items?limit=501` | 400 | INVALID_QUERY |
| REC-019c limit=abc | `GET /reconciliations/{{run_id}}/items?limit=abc` | 400 | INVALID_QUERY |
| REC-019d limit=1.5 | `GET /reconciliations/{{run_id}}/items?limit=1.5` | 400 | INVALID_QUERY |
| REC-020a limit repeated | `GET /reconciliations/{{run_id}}/items?limit=1&limit=2` | 400 | INVALID_QUERY |
| REC-020b caseStatus repeated | `GET /reconciliations/{{run_id}}/items?caseStatus=OPEN&caseStatus=OPEN` | 400 | INVALID_QUERY |
| REC-021 cursor invalid | `GET /reconciliations/{{run_id}}/items?cursor=abc` | 400 | INVALID_QUERY |
| REC-022 Items of a run that does not exist | `GET /reconciliations/does-not-exist/items` | 404 | RECONCILIATION_NOT_FOUND |
| RES-009 Filter by caseStatus returns only that status | `GET /reconciliations/{{run_id}}/items?caseStatus=OPEN` | 200 |  |

**Resolve: validation** (10 request)

| Request | Gọi | Status | Mã lỗi |
| --- | --- | --- | --- |
| RES-005a status OPEN | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-005b status DONE | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-005c status missing | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-006a note empty | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-006b note 501 chars | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-007a resolvedBy empty | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-007b resolvedBy 65 chars | `POST /reconciliation-items/nope/resolve` | 422 | INVALID_RECONCILIATION |
| RES-008 Item not found | `POST /reconciliation-items/nope/resolve` | 404 | RECONCILIATION_ITEM_NOT_FOUND |
| RES-010 Body is array | `POST /reconciliation-items/nope/resolve` | 400 | INVALID_REQUEST |
| RES-011 Missing tenant | `POST /reconciliation-items/nope/resolve` | 400 | MISSING_TENANT |

## Phần không đưa vào Postman (và lý do)

| Mục | Lý do | Nơi xử lý |
| --- | --- | --- |
| `IDM-006`, `CON-001..004`, `PAY-033` (gửi đồng thời) | Postman Runner gửi tuần tự | Bắn song song bằng `curl ... &` theo test plan manual |
| `SIM-005`, `SIM-006` (`response=timeout`, ~30 s) | Quá chậm cho Regression | [`02-manual-payment-simulator.md`](02-manual-payment-simulator.md) |
| `SIM-007`, `SIM-008`, `PAY-04x` (webhook payment drop/duplicate/retry) | Không có endpoint quan sát webhook của payment | Manual (log/Kibana) |
| Order bất đồng bộ (`ORD-*`, `DLQ-*`, `RES-*`) | RabbitMQ, không có HTTP | [`03-manual-order-payment.md`](03-manual-order-payment.md) |
| `RPL-001`, `RPL-003`, `FRZ-011` (replay-paid thật, freeze chặn order) | Cần order đã trả qua RabbitMQ | Manual (nhóm C và D) |
| `REC-030..036` (dựng các loại lệch đối soát) | Cần dừng payment/wallet, ký webhook giả | [`05-manual-reconciliation.md`](05-manual-reconciliation.md) |
| Retention (`RET-*`) | Cần cấu hình service, dữ liệu đủ cũ | [`06-manual-retention-observability.md`](06-manual-retention-observability.md) |
| `OPS-002`, `PAY-011`, `IDM-002` (khoảng trắng đầu/cuối header) | Postman có thể tự cắt khoảng trắng của header | Manual bằng `curl`; Postman dùng biến thể "key 256 ký tự" |

## Giới hạn và giả định cần xác nhận

1. **Poll cần Runner/Newman** như Smoke.
2. Các request webhook ký tay dùng `CryptoJS` có sẵn trong sandbox Postman; thiếu `webhook_secret` thì test bị bỏ qua (`pm.test.skip`) nhưng request vẫn được gửi (và nhận 401).
3. `WHK-010b` (gửi lại cùng `eventId` trả `DUPLICATE`) suy ra từ `pay-order`/`apply-payment-result` (`inbox.record`); nếu thực tế khác, sửa test.
4. `LED-002` và `ADJ-013` kiểm số dư tuyệt đối theo thứ tự chạy của Setup; chạy lại **cả folder** (không chạy lẻ).
5. `SIM-003b` kiểm "còn PENDING ngay sau khi tạo" nên có thể lỗi giả nếu máy chậm hơn 3 giây giữa hai request.
6. Mọi lệnh `POST /ops/...` ghi `ops_actions` vĩnh viễn (bảng chỉ thêm).

## Kết quả thực thi (điền khi chạy)

| Collection | Ngày | Người chạy | Pass/Fail | Request lỗi và ghi chú |
| --- | --- | --- | --- | --- |
| | | | | |
