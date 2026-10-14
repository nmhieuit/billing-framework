# E6 — Đối soát sau giao dịch

## Mục tiêu

Phần 1: sau một giao dịch nạp tiền bình thường, chạy đối soát hôm nay và xác nhận không có ca lệch nào liên quan đến giao dịch đó.

Phần 2 (tùy chọn, ghi dữ liệu lệch): tạo một charge ở payment không thuộc topup nào, chạy đối soát và xác nhận ca `UNKNOWN_CHARGE` được ghi nhận, rồi đóng ca.

- Service tham gia: wallet, payment.
- Có phần tiêm lỗi hoặc tạo lỗi: không.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe.
- Phần 2 để lại một ca lệch `OPEN` trong đối soát của hôm nay, ảnh hưởng các test đối soát "lượt sạch" khác: chỉ chạy khi chấp nhận điều đó.
- Đóng ca (bước cuối của Phần 2) chỉ thực sự ghi khi biến `reconciliation_resolve_enabled` là `true`; mặc định `false` thì các test ở bước đó được bỏ qua.
- Dùng **Postman app Runner** hoặc **Newman** nếu chạy hai phần tách rời (CLI không giữ biến giữa các lần chạy).

## Cách chạy

| Phần | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| Phần 1 Đối soát không lệch | 9 | 9 request (wallet 8, payment 1) | `cd22d9e7-59c7-581f-a970-91a1e8c9c6c8` |
| Phần 2 Dựng ca lệch UNKNOWN_CHARGE (tùy chọn) | 7 | 7 request (wallet 5, payment 2) | `0e65bb0e-d2b6-501c-ab90-90b2e9064aff` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải từng folder phần > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 60 giây cho phần dài nhất.

**Không chạy cả folder `E6 Đối soát sau giao dịch` một lần.** Luồng này có thao tác tay xen giữa các phần; chạy từng phần theo đúng thứ tự trong bảng "Các bước", làm thao tác tay ở giữa.

**Chạy bằng Newman** (cần giữ biến giữa các phần; Postman CLI không giữ biến giữa các lần chạy nên không dùng):

```bash
npx newman run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  --export-environment e2e-state.json --folder cd22d9e7-59c7-581f-a970-91a1e8c9c6c8   # Phần 1 Đối soát không lệch
# các phần sau: thay -e bằng e2e-state.json, giữ --export-environment e2e-state.json, đổi --folder sang id phần kế tiếp
```

## Các phần

### Phần Phần 1 Đối soát không lệch

Giao dịch nạp tiền bình thường không sinh ca lệch.

- Gồm các bước: 1 đến 9.
- Trước phần này: không có thao tác tay.
- Sau phần này: không có thao tác tay.

### Phần Phần 2 Dựng ca lệch UNKNOWN_CHARGE (tùy chọn)

Tạo charge không thuộc topup nào để đối soát ghi nhận ca lệch.

- Gồm các bước: 10 đến 16.
- Trước phần này: không có thao tác tay.
- Sau phần này: không có thao tác tay.

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E6-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E6-02 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 3 | Tay hoặc Runner | `E6-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E6-04 Yêu cầu nạp 150000` | `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E6-05 Poll topup đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E6-06 Bắt đầu đối soát hôm nay` | `202`; `status` `RUNNING`, có `runId`. |
| 7 | Poll (tay: gửi lại; Runner: tự lặp) | `E6-07 Poll lượt đối soát đến COMPLETED` | `200`; cuối cùng `status` `COMPLETED`, `failureReason` `null`, `triggeredBy` `MANUAL`. |
| 8 | Tay hoặc Runner | `E6-08 Không có ca lệch của topup này` | `200`; không có ca nào có `topupId` = id topup của luồng. |
| 9 | Tay hoặc Runner | `E6-09 Số dư vẫn 150000 sau đối soát` | `200`; `balance` `150000`. |
| 10 | Tay hoặc Runner | `E6-10 Tạo charge mồ côi ở payment` | `202`; `status` `PENDING`. |
| 11 | Poll (tay: gửi lại; Runner: tự lặp) | `E6-11 Poll charge mồ côi đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 12 | Tay hoặc Runner | `E6-12 Bắt đầu đối soát lần hai` | `202`; `status` `RUNNING`, có `runId`. |
| 13 | Poll (tay: gửi lại; Runner: tự lặp) | `E6-13 Poll lượt đối soát lần hai đến COMPLETED` | `200`; cuối cùng `status` `COMPLETED`. |
| 14 | Tay hoặc Runner | `E6-14 Có ca UNKNOWN_CHARGE cho charge mồ côi` | `200`; đúng 1 ca có `chargeId` = charge mồ côi, `kind` `UNKNOWN_CHARGE`, `caseStatus` `OPEN`, `topupId` `null`, `action` `NONE`. |
| 15 | Tay hoặc Runner | `E6-15 Số dư vẫn 150000 (ca lệch không tự ghi sổ)` | `200`; `balance` `150000`. |
| 16 | Tay hoặc Runner | `E6-16 Đóng ca lệch (RESOLVED)` | Khi bật: `200`, `caseStatus` `RESOLVED`, `resolvedBy` `qa.tester`. Khi tắt: test bỏ qua (request vẫn được gửi). |

## Chi tiết từng bước

### Bước 1 — Wallet health và khởi tạo lượt chạy

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/health`
- Làm gì: Kiểm tra wallet khỏe và tạo mã lượt chạy mới (customer id mới, ngày UTC hôm nay). Luôn chạy bước này đầu tiên của luồng.
- Kết quả mong đợi: `200`, `{"status":"ok","service":"wallet"}`.
- Biến: Ghi: `e2e_run`, `e2e_cust`, `e2e_today`.

### Bước 2 — Payment health

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/health`
- Làm gì: Kiểm tra payment khỏe.
- Kết quả mong đợi: `200`, `{"status":"ok","service":"payment"}`.
- Biến: Không đọc/ghi biến.

### Bước 3 — Tạo ví VND

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/wallets`
- Làm gì: Tạo ví VND cho customer của lượt chạy.
- Kết quả mong đợi: `201`; `currency` `VND`, `balance` `0`.
- Biến: Đọc: `e2e_cust`.

### Bước 4 — Yêu cầu nạp 150000

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi yêu cầu nạp 150000 VND với `Idempotency-Key` mới. Wallet luôn trả `202` rồi mới xử lý bất đồng bộ.
- Kết quả mong đợi: `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`.
- Biến: Ghi: `e2e_topup_key`, `e2e_topup_id`. Đọc: `e2e_cust`.

### Bước 5 — Poll topup đến SUCCEEDED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Chờ topup có trạng thái cuối. Chạy tay: gửi lại request mỗi 1-2 giây cho đến khi `status` là `SUCCEEDED`. Runner: tự lặp tối đa `e2e_poll_max_attempts` lần, mỗi lần cách `poll_interval_ms`.
- Kết quả mong đợi: `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`.
- Biến: Đọc: `e2e_topup_id`, `e2e_poll_max_attempts`, `poll_interval_ms`.

### Bước 6 — Bắt đầu đối soát hôm nay

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/reconciliations`
- Làm gì: Bắt đầu một lượt đối soát cho ngày UTC hôm nay (chạy nền).
- Kết quả mong đợi: `202`; `status` `RUNNING`, có `runId`.
- Biến: Ghi: `e2e_run_id`. Đọc: `e2e_today`.

### Bước 7 — Poll lượt đối soát đến COMPLETED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/reconciliations/{{e2e_run_id}}`
- Làm gì: Chờ lượt đối soát kết thúc. Chạy tay: gửi lại đến khi `status` là `COMPLETED`. Runner: tự lặp.
- Kết quả mong đợi: `200`; cuối cùng `status` `COMPLETED`, `failureReason` `null`, `triggeredBy` `MANUAL`.
- Biến: Đọc: `e2e_run_id`, `e2e_today`, `e2e_poll_max_attempts`.

### Bước 8 — Không có ca lệch của topup này

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/reconciliations/{{e2e_run_id}}/items?limit=500`
- Làm gì: Liệt kê các ca của lượt đối soát và kiểm không có ca nào gắn với topup vừa nạp.
- Kết quả mong đợi: `200`; không có ca nào có `topupId` = id topup của luồng.
- Biến: Đọc: `e2e_run_id`, `e2e_topup_id`.
- Lưu ý:
  - Có thể vẫn có ca khác trong danh sách do dữ liệu của các test trước đó; luồng chỉ kiểm ca của giao dịch này.

### Bước 9 — Số dư vẫn 150000 sau đối soát

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: đối soát không được làm đổi số dư của giao dịch bình thường.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 10 — Tạo charge mồ côi ở payment

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{payment_base_url}}/charges`
- Làm gì: Tạo charge 20000 VND thẳng ở payment, có `metadata.tenantId` của tenant nhưng `reference` không khớp topup nào.
- Kết quả mong đợi: `202`; `status` `PENDING`.
- Biến: Ghi: `e2e_charge_key`, `e2e_orphan_id`. Đọc: `e2e_run`, `tenant_id`.
- Lưu ý:
  - Charge này làm đối soát hôm nay có thêm một ca `UNKNOWN_CHARGE` (ghi dữ liệu lệch).

### Bước 11 — Poll charge mồ côi đến SUCCEEDED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{payment_base_url}}/charges/{{e2e_orphan_id}}`
- Làm gì: Chờ charge có trạng thái cuối. Chạy tay: gửi lại cho đến khi `status` là `SUCCEEDED`. Runner: tự lặp.
- Kết quả mong đợi: `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`.
- Biến: Đọc: `e2e_orphan_id`, `e2e_poll_max_attempts`, `poll_interval_ms`.

### Bước 12 — Bắt đầu đối soát lần hai

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/reconciliations`
- Làm gì: Bắt đầu lượt đối soát mới cho hôm nay (mỗi lượt là một bản ghi mới, bất biến).
- Kết quả mong đợi: `202`; `status` `RUNNING`, có `runId`.
- Biến: Ghi: `e2e_run_id2`. Đọc: `e2e_today`.

### Bước 13 — Poll lượt đối soát lần hai đến COMPLETED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/reconciliations/{{e2e_run_id2}}`
- Làm gì: Chờ lượt đối soát thứ hai kết thúc.
- Kết quả mong đợi: `200`; cuối cùng `status` `COMPLETED`.
- Biến: Đọc: `e2e_run_id2`, `e2e_poll_max_attempts`.

### Bước 14 — Có ca UNKNOWN_CHARGE cho charge mồ côi

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/reconciliations/{{e2e_run_id2}}/items?limit=500`
- Làm gì: Tìm ca của charge mồ côi trong lượt đối soát thứ hai.
- Kết quả mong đợi: `200`; đúng 1 ca có `chargeId` = charge mồ côi, `kind` `UNKNOWN_CHARGE`, `caseStatus` `OPEN`, `topupId` `null`, `action` `NONE`.
- Biến: Ghi: `e2e_item_id` (rỗng nếu `reconciliation_resolve_enabled` không phải `true`). Đọc: `e2e_run_id2`, `e2e_orphan_id`, `reconciliation_resolve_enabled`.

### Bước 15 — Số dư vẫn 150000 (ca lệch không tự ghi sổ)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: ca `UNKNOWN_CHARGE` không được tự ghi vào ví.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 16 — Đóng ca lệch (RESOLVED)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/reconciliation-items/{{e2e_item_id}}/resolve`
- Làm gì: Đóng ca bằng ghi chú. Chỉ thực sự kiểm khi `reconciliation_resolve_enabled` là `true`.
- Kết quả mong đợi: Khi bật: `200`, `caseStatus` `RESOLVED`, `resolvedBy` `qa.tester`. Khi tắt: test bỏ qua (request vẫn được gửi).
- Biến: Đọc: `e2e_item_id`, `e2e_run`, `reconciliation_resolve_enabled`.
- Lưu ý:
  - `e2e_item_id` chỉ được đặt ở bước trước khi `reconciliation_resolve_enabled` là `true`. Khi cờ tắt, `e2e_item_id` rỗng, request gửi tới đường dẫn không hợp lệ (không đóng ca nào) và test được bỏ qua.

## Kiểm tra cuối luồng

- Phần 1: không có ca lệch nào gắn với topup của luồng; số dư không đổi.
- Phần 2: ca `UNKNOWN_CHARGE` được ghi nhận (`OPEN`, không tự ghi sổ); khi bật cờ thì đóng được ca.
