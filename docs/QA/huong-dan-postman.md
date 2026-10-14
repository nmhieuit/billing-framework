# Hướng dẫn dùng Postman

## 1. Tệp

| Tệp | Nội dung |
| --- | --- |
| [`postman/billing.postman_collection.json`](postman/billing.postman_collection.json) | Collection duy nhất `Billing` (Postman v2.1) |
| [`postman/billing-local.postman_environment.json`](postman/billing-local.postman_environment.json) | Environment `billing-local` |

Danh tính không dùng token (xem [`gioi-thieu-he-thong.md`](gioi-thieu-he-thong.md)), nên không có biến token. Tên `{{wallet_base_url}}`/`{{payment_base_url}}` thay cho `{{base_url}}` vì hai service ở hai cổng khác nhau.

## 2. Cấu trúc collection

```
Billing
├─ Wallet            ─ Smoke, Regression, EndPoints
├─ Payment           ─ Smoke, Regression, EndPoints
├─ Ops               ─ Smoke, Regression, EndPoints
├─ Reconciliations   ─ Smoke, Regression, EndPoints
└─ Chaos             ─ Smoke, Workload, Oracle, Regression
```

- **Smoke**: luồng happy path đầu-cuối của service.
- **Regression**: bắt đầu bằng folder `Happy path` (một phần request của Smoke, đủ cho một luồng đầu-cuối), sau đó `Setup` (dựng dữ liệu cho các test bên dưới) rồi các folder negative và edge case theo chủ đề. **Chạy từ trên xuống**.
- **EndPoints**: mỗi endpoint một request, kèm Docs (header, tham số, giá trị cho phép, mã lỗi, ví dụ `curl`); subfolder `Enum variants` có request cho từng giá trị enum quan trọng. Mỗi `EndPoints` tự tạo customer `ep_cust` khi cần.
- **Chaos**: xem [`test-case/chaos.md`](test-case/chaos.md).

### Tiền tố `[S]` / `[R]`

Mỗi request trong `Regression` có tiền tố ở **đầu mô tả (Docs)**:
- `[S]`: request happy case, **trùng** với request cùng tên trong folder `Smoke` (cùng URL, script, test). Việc trùng là có chủ ý.
- `[R]`: request negative/edge của Regression.

## 3. Environment và biến

| Biến | Giá trị mặc định | Ý nghĩa |
| --- | --- | --- |
| `wallet_base_url` | `http://localhost:3001` | Wallet (`LOCAL_WALLET_PORT`) |
| `payment_base_url` | `http://localhost:3002` | Payment (`LOCAL_PAYMENT_PORT`) |
| `tenant_id` / `tenant_id_other` | `acme` / `beta` | Hai tenant mặc định (`LOCAL_TENANTS`) |
| `tenant_unknown` | `zzz` | Tenant hợp lệ về định dạng nhưng không được phục vụ |
| `actor_id`, `actor_role` | `qa.tester`, `OPS` | Header `x-actor-*` cho `/ops` |
| `webhook_secret` | **điền từ `deploy/.env`**, kiểu secret | Biến `LOCAL_WEBHOOK_SECRET` trong `deploy/.env`. Cần điền trước khi chạy các request webhook ký tay (nếu trống, các test này bị bỏ qua). Không ghi giá trị vào tài liệu |
| `reconciliation_resolve_enabled` | `false` | `true` mới đóng ca đối soát thật trong Smoke (ghi dữ liệu) |
| `poll_max_attempts`, `poll_interval_ms` | `20`, `1000` | Poll topup/charge/lượt đối soát |
| `chaos_quiesce_seconds`, `chaos_expect_missing_at_wallet`, `chaos_allow_unknown_charge` | `120`, `false`, `true` | Chỉ cho folder `Chaos` (xem [`test-case/chaos.md`](test-case/chaos.md)) |

Các biến chạy (`run`, `cust`, `topup_id`, `charge_id`, `run_id`, `ep_*`...) do script tạo và lưu ở **collection variables**; request đầu của mỗi Smoke/Regression tạo `run` mới nên customer id và `Idempotency-Key` không va chạm giữa các lần chạy. Riêng folder `Chaos` lưu trạng thái ở **environment** (biến `ch_*`).

Các service dùng chung vùng biến của collection (ví dụ `run`, `cust`, `today`). Vì vậy **chạy mỗi folder từ request đầu đến cuối**, không chạy xen kẽ hai folder và không chạy tiếp giữa chừng một folder đã dừng.

## 4. Cách chạy

**Postman app:** Import collection và environment, chọn environment `billing-local`, điền `webhook_secret`. Chuột phải vào folder cần chạy (ví dụ `Wallet > Smoke`) và chọn **Run**, giữ thứ tự mặc định. Các request poll tự lặp lại bằng `postman.setNextRequest`: **chỉ chạy đúng trong Collection Runner hoặc CLI**, không chạy từng request riêng lẻ.

**Postman CLI** (chọn folder bằng **id**, vì tên `Smoke`, `Regression`, `EndPoints` lặp lại ở mỗi service và đường dẫn dạng `Wallet/Smoke` không được nhận):

```bash
postman collection run docs/QA/postman/billing.postman_collection.json   -e docs/QA/postman/billing-local.postman_environment.json   -i 476c8f75-fcea-5a33-a8bf-a4ea589bc033   # Wallet > Smoke
```

Id của từng folder (cũng dùng với `newman --folder`):

| Folder | Id |
| --- | --- |
| Wallet > Smoke | `476c8f75-fcea-5a33-a8bf-a4ea589bc033` |
| Wallet > Regression | `9f3968e1-197b-5ff5-a621-741703d3eca9` |
| Wallet > EndPoints | `7488b164-d1bd-5b2c-a866-e772a4592cba` |
| Payment > Smoke | `b1ba7ade-4cc2-54e5-a32a-353d9a0740ed` |
| Payment > Regression | `6d47f8e5-07c3-557f-a9dc-02c4da9b85b6` |
| Payment > EndPoints | `2f867e83-ebab-587c-a6c1-e2c662abdced` |
| Ops > Smoke | `c496e69d-b9b1-53f1-abb8-6f35ede6492c` |
| Ops > Regression | `15091a23-198d-581e-aea7-281df8db2b94` |
| Ops > EndPoints | `a379f330-b2e3-5301-a037-0df613f998c8` |
| Reconciliations > Smoke | `c2b1b102-0bce-559b-a8f9-2ff51ad965d1` |
| Reconciliations > Regression | `478770f7-f695-5c72-a151-d49b0350df85` |
| Reconciliations > EndPoints | `7be90199-e3a5-544f-ac60-6c2218569d25` |
| Chaos > Smoke | `be3d0715-2439-5180-ada5-5239e08bef1b` |
| Chaos > Workload | `58bb9889-a537-5790-a880-8bfd67fa8239` |
| Chaos > Oracle | `c7aeb48f-1f80-5f4f-a2b3-b33a2d6c9b85` |
| Chaos > Regression | `edab67c8-dd9d-5abe-aeb6-40c30cd6aed6` |

Thứ tự khuyến nghị: Payment, Wallet, Ops, Reconciliations (đối soát đọc sao kê payment và dữ liệu wallet).

**Folder `Chaos`** giữ trạng thái giữa các folder trong environment nên cần xuất environment sau mỗi lần chạy. Postman CLI không có tùy chọn này; dùng Collection Runner trong Postman app (cùng một environment), hoặc Newman:

```bash
npx newman run docs/QA/postman/billing.postman_collection.json   -e docs/QA/postman/billing-local.postman_environment.json   --export-environment chaos-state.json --folder be3d0715-2439-5180-ada5-5239e08bef1b   # Chaos > Smoke
# các lần sau dùng -e chaos-state.json, --folder <id Workload> -n 25, rồi <id Oracle>
```

## 5. Điều kiện và tác dụng phụ

- Stack local đã lên và khỏe ([`moi-truong-va-du-lieu.md`](moi-truong-va-du-lieu.md)). **Không** trỏ vào môi trường dùng chung.
- Mỗi lần chạy **ghi dữ liệu thật** vào DB local: ví, topup, charge, sổ cái, `ops_actions` (bảng chỉ thêm, không xóa được), lượt đối soát. Dữ liệu không được dọn.
- Charge tạo trực tiếp ở payment **không có `metadata.tenantId`**: webhook về wallet bị từ chối (400) và payment gửi lại theo backoff `1,5,30,120,600` giây rồi `FAILED` (khoảng 12 phút). Không đổi số dư nhưng làm nhiễu log và metric webhook.
- Lượt đối soát đọc sao kê payment của **cả ngày UTC hiện tại**; chạy gần nửa đêm UTC có thể lệch ngày.
- Smoke của `Ops` không có `replay-paid` vì cần một order đã trả qua RabbitMQ.
- Smoke Payment không kiểm webhook (payment không có endpoint xem webhook); quan sát bằng log hoặc Kibana ([`test-case/payment-simulator.md`](test-case/payment-simulator.md)).
- Đóng ca đối soát mặc định **tắt** (`reconciliation_resolve_enabled=false`) vì là thao tác ghi vào ca thật.
- Request poll hết `poll_max_attempts` mà chưa tới trạng thái cuối thì test báo lỗi.
- `LED-002` (tổng entries = số dư) và `ADJ-013` kiểm số dư tuyệt đối theo thứ tự chạy của `Setup`: chạy lại **cả folder**, không chạy lẻ.
- Các request webhook ký tay dùng `CryptoJS` có sẵn trong Postman; thiếu `webhook_secret` thì test bị bỏ qua nhưng request vẫn được gửi (và nhận 401).
- Mọi lệnh `POST /ops/...` ghi `ops_actions` vĩnh viễn.

## 6. Smoke: các request

Mỗi request kiểm **status**, **schema** và **dữ liệu chính**; dữ liệu được truyền giữa các request bằng biến.

#### Wallet

| Request | Gọi | Status | Kỳ vọng thêm |
| --- | --- | --- | --- |
| HLT-W01 Wallet health | `GET /health` | 200 |  |
| WLT-001 Create wallet (VND) | `POST /wallets` | 201 |  |
| WLT-002 Create wallet again (idempotent) | `POST /wallets` | 200 |  |
| WLT-012 Get wallet (balance 0) | `GET /wallet` | 200 |  |
| TOP-001a Request topup 150000 | `POST /topups` | 202 |  |
| TOP-001b Poll topup until SUCCEEDED | `GET /topups/{{topup_id}}` | 200 | lặp tới trạng thái cuối |
| TOP-001c Get wallet (balance 150000) | `GET /wallet` | 200 |  |
| TOP-003 Get topup | `GET /topups/{{topup_id}}` | 200 |  |
| IDM-003 Replay topup with same key | `POST /topups` | 202 |  |
| IDM-003b Balance unchanged after replay | `GET /wallet` | 200 |  |
| LED-001 List ledger entries | `GET /wallet/entries` | 200 |  |
| LED-002 Entries sum equals balance | `GET /wallet/entries?limit=1000` | 200 |  |
| TEN-001a Same customer in other tenant: create wallet | `POST /wallets` | 201 |  |
| TEN-001b Other tenant balance is 0 | `GET /wallet` | 200 |  |

#### Payment

| Request | Gọi | Status | Kỳ vọng thêm |
| --- | --- | --- | --- |
| HLT-P01 Payment health | `GET /health` | 200 |  |
| PAY-001 Create charge | `POST /charges` | 202 |  |
| PAY-002 Poll charge until SUCCEEDED | `GET /charges/{{charge_id}}` | 200 | lặp tới trạng thái cuối |
| PAY-030 Replay with same key returns same charge | `POST /charges` | 202 |  |
| SIM-001a Create charge that fails (fail=card_declined) | `POST /charges` | 202 |  |
| SIM-001b Poll failing charge until FAILED | `GET /charges/{{charge_fail_id}}` | 200 | lặp tới trạng thái cuối |
| STL-001 Settlement of today contains both charges | `GET /settlements?date={{today}}` | 200 |  |

#### Ops

| Request | Gọi | Status | Kỳ vọng thêm |
| --- | --- | --- | --- |
| SETUP-O01 Init run + create wallet | `POST /wallets` | 201 |  |
| FRZ-001 Freeze wallet | `POST /ops/wallets/{{cust}}/freeze` | 200 |  |
| FRZ-002 Freeze again is a no-op | `POST /ops/wallets/{{cust}}/freeze` | 200 |  |
| FRZ-004 Unfreeze wallet | `POST /ops/wallets/{{cust}}/unfreeze` | 200 |  |
| ADJ-001 Adjust CREDIT 50000 | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-001b Balance is 50000 | `GET /wallet` | 200 |  |
| ADJ-004 Replay adjustment with same key | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-004b Balance unchanged after replay | `GET /wallet` | 200 |  |
| ADJ-002 Adjust DEBIT 20000 | `POST /ops/wallets/{{cust}}/adjustments` | 201 |  |
| ADJ-002b Balance is 30000 | `GET /wallet` | 200 |  |
| REV-001 Reverse the DEBIT adjustment | `POST /ops/transactions/{{tx_debit}}/reversals` | 201 |  |
| REV-001b Balance back to 50000 | `GET /wallet` | 200 |  |
| LED-ADJ Entries include adjustment and reversal keys | `GET /wallet/entries?limit=100` | 200 |  |
| LOG-001 List ops actions | `GET /ops/actions?limit=20` | 200 |  |

#### Reconciliations

| Request | Gọi | Status | Kỳ vọng thêm |
| --- | --- | --- | --- |
| HLT-R01 Wallet health + init run | `GET /health` | 200 |  |
| REC-001a Start reconciliation for today (UTC) | `POST /reconciliations` | 202 |  |
| REC-001b Poll run until COMPLETED | `GET /reconciliations/{{run_id}}` | 200 | lặp tới trạng thái cuối |
| REC-002 Get run | `GET /reconciliations/{{run_id}}` | 200 |  |
| REC-004 Re-run creates a new immutable run | `POST /reconciliations` | 202 |  |
| REC-003 List items of the run | `GET /reconciliations/{{run_id}}/items` | 200 |  |
| RES-001 Resolve an open item (RESOLVED) | `POST /reconciliation-items/{{item_id}}/resolve` | 200 |  |
| RES-003 Resolving again with the same values is idempotent | `POST /reconciliation-items/{{item_id}}/resolve` | 200 |  |
| RES-004 Resolving with different values conflicts | `POST /reconciliation-items/{{item_id}}/resolve` | 409 | RECONCILIATION_CONFLICT |

#### Luồng và dữ liệu chuyển giao

| Collection | Luồng | Biến chuyển giao |
| --- | --- | --- |
| Wallet | Tạo ví, tạo lại (200), nạp 150000, poll `SUCCEEDED`, số dư 150000, replay cùng key (cùng `topupId`), entries khớp số dư, ví cùng customer ở tenant khác | `topup_key`, `topup_id`, `cust` |
| Payment | Tạo charge, poll `SUCCEEDED`, replay cùng key, charge `fail=card_declined` poll `FAILED`, sao kê hôm nay có cả hai | `ck1`, `charge_id`, `charge_fail_id` |
| Ops | Tạo ví, freeze, freeze lần hai (no-op), unfreeze, CREDIT, replay cùng key, DEBIT, đảo DEBIT, nhật ký | `frz_action`, `tx_credit`, `tx_debit` |
| Reconciliations | Chạy lượt hôm nay, poll `COMPLETED`, đọc lượt, chạy lại (lượt mới), liệt kê ca, (tùy chọn) đóng ca | `run_id`, `run_id2`, `item_id` |


## 7. Những gì không có trong Postman

| Mục | Lý do | Nơi xử lý |
| --- | --- | --- |
| `IDM-006`, `CON-001..004`, `PAY-033` (gửi đồng thời) | Postman Runner gửi tuần tự | Bắn song song bằng `curl ... &` theo test case manual |
| `SIM-005`, `SIM-006` (`response=timeout`, ~30 s) | Quá chậm cho Regression | [`payment-simulator.md`](test-case/payment-simulator.md) |
| `SIM-007`, `SIM-008`, `PAY-04x` (webhook payment drop/duplicate/retry) | Không có endpoint quan sát webhook của payment | Manual (log/Kibana) |
| Order bất đồng bộ (`ORD-*`, `DLQ-*`, `RES-*`) | RabbitMQ, không có HTTP | [`order-payment.md`](test-case/order-payment.md) |
| `RPL-001`, `RPL-003`, `FRZ-011` (replay-paid thật, freeze chặn order) | Cần order đã trả qua RabbitMQ | Manual ([`order-payment.md`](test-case/order-payment.md), [`ops.md`](test-case/ops.md)) |
| `REC-030..036` (dựng các loại lệch đối soát) | Cần dừng payment/wallet, ký webhook giả | [`doi-soat.md`](test-case/doi-soat.md) |
| Retention (`RET-*`) | Cần cấu hình service, dữ liệu đủ cũ | [`retention-quan-sat.md`](test-case/retention-quan-sat.md) |
| `OPS-002`, `PAY-011`, `IDM-002` (khoảng trắng đầu/cuối header) | Postman có thể tự cắt khoảng trắng của header | Manual bằng `curl`; Postman dùng biến thể "key 256 ký tự" |

## 8. Giá trị cho phép (enum)

| Enum | Giá trị cho phép | Dùng ở |
| --- | --- | --- |
| Currency | `VND`, `USD` | Mọi endpoint có tiền |
| Topup status | `REQUESTED`, `PENDING`, `SUCCEEDED`, `FAILED` | `GET /topups/:id`, `POST /topups` |
| Topup failureCode (wallet đặt) | `PAYMENT_REJECTED`, `PAYMENT_UNAVAILABLE` (+ mã từ payment) | `GET /topups/:id` |
| Webhook outcome | `APPLIED`, `DUPLICATE`, `UNKNOWN_TOPUP`, `MISMATCH`, `IGNORED` | `POST /webhooks/payment` (response) |
| Webhook type | `charge.succeeded`, `charge.failed` | `POST /webhooks/payment` (body) |
| Webhook status | `SUCCEEDED`, `FAILED` | `POST /webhooks/payment` (body) |
| Ledger transaction kind | `TOPUP`, `ORDER_PAYMENT`, `ADJUSTMENT`, `REVERSAL` | `GET /wallet/entries`, reversals |
| Tiền tố businessKey | `topup:`, `order:`, `adjustment:`, `reversal:` | `GET /wallet/entries` (response) |
| Ops direction | `CREDIT`, `DEBIT` | `POST /ops/.../adjustments` |
| Ops action | `FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID` | `GET /ops/actions` |
| Lý do thất bại order | `INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`, `WALLET_FROZEN` | Sự kiện `OrderPaymentFailedV1` (RabbitMQ), liên quan freeze |
| Run status | `RUNNING`, `COMPLETED`, `FAILED` | Đối soát (response) |
| Run trigger | `SCHEDULED`, `MANUAL` | Đối soát (response) |
| Loại lệch đối soát | `LEDGER_UNBALANCED`, `BALANCE_MISMATCH`, `MISSING_AT_WALLET`, `UNKNOWN_CHARGE`, `MISSING_AT_GATEWAY`, `AMOUNT_MISMATCH`, `STATUS_MISMATCH` | `GET .../items` (response) |
| Autofix action | `NONE`, `AUTO_APPLIED`, `FAILED_AUTOFIX` | `GET .../items` (response) |
| Case status | `OPEN`, `RESOLVED`, `IGNORED` | `GET .../items?caseStatus=` (query) |
| Resolve status | `RESOLVED`, `IGNORED` | `POST /reconciliation-items/:id/resolve` |
| Charge status | `PENDING`, `SUCCEEDED`, `FAILED` | `GET /charges/:id`, `POST /charges` |
| Settlement item status | `SUCCEEDED`, `FAILED` | `GET /settlements` |
| X-Simulate (khóa) | `fail`, `delay`, `webhook`, `response` | `POST /charges` (header) |
| X-Simulate `webhook` | `drop`, `duplicate` | `POST /charges` (header) |
| X-Simulate `response` | `timeout` | `POST /charges` (header) |

Giá trị có ràng buộc nhưng **không phải enum** (ghi ở mục Params/Body của từng request): regex customer id `^[A-Za-z0-9_-]{1,64}$`, tenant `^[a-z][a-z0-9-]{0,39}$`, `failureCode` `^[a-z][a-z0-9_]{0,63}$`, `delay` `1..3600`, `limit` (entries 1..1000; ops actions 1..200; items 1..500; settlements 1..1000), số tiền topup `1..1_000_000_000_000`, `reason` ≤ 500, `idempotencyKey` ≤ 200, `Idempotency-Key` ≤ 255, `note` ≤ 500, `resolvedBy` ≤ 64.
