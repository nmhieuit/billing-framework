# Postman Smoke (nhóm G)

> **Giai đoạn 2, nhóm G.** Bốn collection Postman v2.1 cho local stack, mỗi collection có folder **`Smoke`** (luồng E2E happy path) và **`Regression`** (xem [`08-postman-regression.md`](08-postman-regression.md)).
> Tệp: `docs/QA/postman/{wallet,payment,ops,reconciliations}/<tên>.postman_collection.json` và `docs/QA/postman/billing-local.postman_environment.json`.
> **Đã kiểm tra:** JSON hợp lệ (parse được), schema collection v2.1.0, mọi script `pm.test` qua `node --check` (không lỗi cú pháp), mọi biến `{{...}}` đều được định nghĩa trước khi dùng theo thứ tự chạy.
> **Chưa kiểm tra:** chưa chạy thật qua Postman/Newman với stack local, nên mọi kỳ vọng suy ra từ code và tài liệu. Request nào lệch thực tế sẽ lộ ra ở lần chạy đầu: sửa test, không sửa dữ liệu.
> Chỉ có request cho **endpoint xác minh được từ code** (`docs/QA/00-overview.md` mục 3). Không có request nào cho luồng RabbitMQ (không gọi được bằng HTTP): xem [`03-manual-order-payment.md`](03-manual-order-payment.md).

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

## Smoke: các request

Mỗi request kiểm **status**, **schema** (`pm.response.to.have.jsonSchema`) và **dữ liệu chính**; dữ liệu được **truyền giữa các request** (chaining) bằng biến: `topup_key`, `topup_id` (tạo topup, poll, replay), `charge_id`, `charge_fail_id` (sao kê), `tx_debit`/`tx_credit` (đảo giao dịch), `run_id`, `item_id` (đối soát).

### Wallet

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

### Payment

| Request | Gọi | Status | Kỳ vọng thêm |
| --- | --- | --- | --- |
| HLT-P01 Payment health | `GET /health` | 200 |  |
| PAY-001 Create charge | `POST /charges` | 202 |  |
| PAY-002 Poll charge until SUCCEEDED | `GET /charges/{{charge_id}}` | 200 | lặp tới trạng thái cuối |
| PAY-030 Replay with same key returns same charge | `POST /charges` | 202 |  |
| SIM-001a Create charge that fails (fail=card_declined) | `POST /charges` | 202 |  |
| SIM-001b Poll failing charge until FAILED | `GET /charges/{{charge_fail_id}}` | 200 | lặp tới trạng thái cuối |
| STL-001 Settlement of today contains both charges | `GET /settlements?date={{today}}` | 200 |  |

### Ops

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

### Reconciliations

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

### Luồng và dữ liệu chuyển giao

| Collection | Luồng | Biến chuyển giao |
| --- | --- | --- |
| Wallet | Tạo ví, tạo lại (200), nạp 150000, poll `SUCCEEDED`, số dư 150000, replay cùng key (cùng `topupId`), entries khớp số dư, ví cùng customer ở tenant khác | `topup_key`, `topup_id`, `cust` |
| Payment | Tạo charge, poll `SUCCEEDED`, replay cùng key, charge `fail=card_declined` poll `FAILED`, sao kê hôm nay có cả hai | `ck1`, `charge_id`, `charge_fail_id` |
| Ops | Tạo ví, freeze, freeze lần hai (no-op), unfreeze, CREDIT, replay cùng key, DEBIT, đảo DEBIT, nhật ký | `frz_action`, `tx_credit`, `tx_debit` |
| Reconciliations | Chạy lượt hôm nay, poll `COMPLETED`, đọc lượt, chạy lại (lượt mới), liệt kê ca, (tùy chọn) đóng ca | `run_id`, `run_id2`, `item_id` |

## Giới hạn và giả định cần xác nhận

1. **Poll cần Runner/Newman** (dùng `postman.setNextRequest`); hết `poll_max_attempts` thì test báo lỗi.
2. **`LED-002` (tổng entries = số dư)** giả định các entry của ví cộng lại bằng số dư (dấu entry nạp là dương). Nếu quy ước dấu khác, test này sẽ lộ ra khi chạy; sửa theo thực tế.
3. **Smoke Ops không có `replay-paid`** vì cần một order đã trả qua RabbitMQ.
4. **Smoke Payment không kiểm webhook** (payment không có endpoint xem webhook). Quan sát bằng log/Kibana theo [`02-manual-payment-simulator.md`](02-manual-payment-simulator.md).
5. **Đóng ca đối soát** mặc định **tắt** (`reconciliation_resolve_enabled=false`) vì thao tác ghi vào ca thật.
6. `STL-001` (sao kê hôm nay) có thể lệch gần nửa đêm UTC.

## Kết quả thực thi (điền khi chạy)

| Collection | Ngày | Người chạy | Pass/Fail | Request lỗi và ghi chú |
| --- | --- | --- | --- | --- |
| | | | | |
