# E2 — Nạp tiền thất bại (payment từ chối)

## Mục tiêu

Kiểm tra khi payment từ chối một charge thì không có tiền nào di chuyển vào ví. Wallet không gửi được header `X-Simulate` sang payment, nên luồng này tạo charge thất bại **trực tiếp ở payment** (kèm `metadata.tenantId` của tenant và một `reference` không thuộc topup nào), rồi đối chiếu payment và ví.

- Service tham gia: wallet, payment.
- Có phần tiêm lỗi hoặc tạo lỗi: có.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe.
- Đã chọn environment `billing-local`.

## Cách chạy

| Folder | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| E2 Nạp tiền thất bại (payment từ chối) | 8 | 8 request (wallet 4, payment 4) | `935c6dcb-3fc5-54e0-a797-89d86c2a3ba7` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải folder `E2 Nạp tiền thất bại (payment từ chối)` > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 30 giây cho phần dài nhất.

**Chạy bằng Postman CLI:**

```bash
postman collection run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  -i 935c6dcb-3fc5-54e0-a797-89d86c2a3ba7
```

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E2-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E2-02 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 3 | Tay hoặc Runner | `E2-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E2-04 Tạo charge thất bại thẳng ở payment (fail=card_declined)` | `202`; `status` `PENDING`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E2-05 Poll charge đến FAILED` | `200`; cuối cùng `status` `FAILED`, `failureCode` `card_declined`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E2-06 Số dư vẫn 0` | `200`; `balance` `0`. |
| 7 | Tay hoặc Runner | `E2-07 Sổ cái trống` | `200`; `items` rỗng. |
| 8 | Tay hoặc Runner | `E2-08 Sao kê payment có charge FAILED` | `200`; đúng 1 charge có `chargeId` = `e2e_charge_id`, `status` `FAILED`, `amount` `50000`. |
| 9 | Thao tác tay | Quan sát webhook của charge thất bại (không bắt buộc) | Xem Bước 9 ở phần chi tiết |

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

### Bước 4 — Tạo charge thất bại thẳng ở payment (fail=card_declined)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{payment_base_url}}/charges`
- Làm gì: Tạo charge 50000 VND ở payment với kịch bản `X-Simulate: fail=card_declined`. Charge có `metadata.tenantId`, nên webhook gửi về wallet được nhận diện tenant.
- Kết quả mong đợi: `202`; `status` `PENDING`.
- Biến: Ghi: `e2e_charge_key`, `e2e_charge_id`. Đọc: `e2e_run`, `tenant_id`.
- Lưu ý:
  - `reference` không khớp topup nào, nên số dư ví không thể đổi.

### Bước 5 — Poll charge đến FAILED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{payment_base_url}}/charges/{{e2e_charge_id}}`
- Làm gì: Chờ charge có trạng thái cuối. Chạy tay: gửi lại cho đến khi `status` là `FAILED`. Runner: tự lặp.
- Kết quả mong đợi: `200`; cuối cùng `status` `FAILED`, `failureCode` `card_declined`, có `completedAt`.
- Biến: Đọc: `e2e_charge_id`, `e2e_poll_max_attempts`, `poll_interval_ms`.

### Bước 6 — Số dư vẫn 0

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư ví: charge thất bại không được làm đổi số dư.
- Kết quả mong đợi: `200`; `balance` `0`.
- Biến: Đọc: `e2e_cust`.

### Bước 7 — Sổ cái trống

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: ví chưa có giao dịch nào.
- Kết quả mong đợi: `200`; `items` rỗng.
- Biến: Đọc: `e2e_cust`.

### Bước 8 — Sao kê payment có charge FAILED

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge vừa tạo.
- Kết quả mong đợi: `200`; đúng 1 charge có `chargeId` = `e2e_charge_id`, `status` `FAILED`, `amount` `50000`.
- Biến: Đọc: `e2e_today`, `e2e_charge_id`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp: chạy lại luồng sau nửa đêm.

### Bước 9 — Quan sát webhook của charge thất bại (không bắt buộc) (thao tác tay)

1. Xem log của cả hai service: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs payment wallet`.
2. Tìm webhook `charge.failed` của charge vừa tạo: payment gửi về wallet; vì `reference` không khớp topup nào, wallet trả `200` với `{"outcome":"UNKNOWN_TOPUP"}` và payment coi là đã giao.
3. Ghi lại nội dung log thực tế để so sánh các lần chạy.

## Kiểm tra cuối luồng

- Charge ở payment `FAILED` với `failureCode` `card_declined`.
- Số dư ví `0`, sổ cái trống.
- Sao kê payment có charge `FAILED`.

## Lưu ý khi tiêm lỗi

- Luồng dùng kịch bản `X-Simulate: fail=card_declined` gửi trong header của request tạo charge (bước 4); không cần lệnh `docker`.
- Chỉ làm trên local stack với dữ liệu thử.
