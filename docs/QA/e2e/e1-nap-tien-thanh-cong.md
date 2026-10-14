# E1 — Nạp tiền thành công

## Mục tiêu

Kiểm tra trọn vẹn một lần nạp tiền đi qua cả hai service: wallet nhận yêu cầu, gửi charge sang payment, payment hoàn tất và gửi webhook về wallet, wallet cộng ví và ghi sổ cái. Cuối luồng số dư, sổ cái và sao kê payment phải khớp nhau, và gửi lại cùng `Idempotency-Key` không cộng tiền lần hai.

- Service tham gia: wallet, payment.
- Có phần tiêm lỗi hoặc tạo lỗi: không.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe ([`../moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md)).
- Đã chọn environment `billing-local`.

## Cách chạy

| Folder | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| E1 Nạp tiền thành công | 11 | 11 request (wallet 9, payment 2) | `7f6d4192-dcea-5d96-a985-31eb6233e75b` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải folder `E1 Nạp tiền thành công` > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 30 giây cho phần dài nhất.

**Chạy bằng Postman CLI:**

```bash
postman collection run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  -i 7f6d4192-dcea-5d96-a985-31eb6233e75b
```

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E1-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E1-02 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 3 | Tay hoặc Runner | `E1-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E1-04 Yêu cầu nạp 150000` | `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E1-05 Poll topup đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E1-06 Số dư = 150000 sau khi nạp` | `200`; `balance` `150000`. |
| 7 | Tay hoặc Runner | `E1-07 Sổ cái có đúng 1 entry topup và khớp số dư` | `200`; tổng `amount` các entry = `150000`; đúng 1 entry `topup:<topupId>`. |
| 8 | Tay hoặc Runner | `E1-08 Tra cứu topup` | `200`; `status` `SUCCEEDED`, `amount` `150000`, có `completedAt`, không có `failureCode`. |
| 9 | Tay hoặc Runner | `E1-09 Sao kê payment có charge của topup` | `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`. |
| 10 | Tay hoặc Runner | `E1-10 Gửi lại cùng Idempotency-Key` | `202`; trả về **cùng `topupId`** với lần đầu, không tạo topup mới. |
| 11 | Tay hoặc Runner | `E1-11 Số dư vẫn 150000 sau khi gửi lại` | `200`; `balance` `150000`. |

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

### Bước 6 — Số dư = 150000 sau khi nạp

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư ví sau khi topup `SUCCEEDED`.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 7 — Sổ cái có đúng 1 entry topup và khớp số dư

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: có đúng một entry có `businessKey` `topup:<topupId>`, và tổng các entry bằng số dư.
- Kết quả mong đợi: `200`; tổng `amount` các entry = `150000`; đúng 1 entry `topup:<topupId>`.
- Biến: Đọc: `e2e_cust`.

### Bước 8 — Tra cứu topup

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Đọc lại topup đã hoàn tất.
- Kết quả mong đợi: `200`; `status` `SUCCEEDED`, `amount` `150000`, có `completedAt`, không có `failureCode`.
- Biến: Đọc: `e2e_topup_id`, `e2e_cust`.

### Bước 9 — Sao kê payment có charge của topup

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge có `reference` bằng id topup (wallet dùng id topup làm `reference` khi gửi charge sang payment).
- Kết quả mong đợi: `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`.
- Biến: Đọc: `e2e_today`, `e2e_topup_id`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp so với `e2e_today`: chạy lại luồng sau nửa đêm.

### Bước 10 — Gửi lại cùng Idempotency-Key

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi lại đúng yêu cầu nạp ở trên (cùng `Idempotency-Key`, cùng nội dung).
- Kết quả mong đợi: `202`; trả về **cùng `topupId`** với lần đầu, không tạo topup mới.
- Biến: Đọc: `e2e_topup_key`, `e2e_topup_id`.
- Lưu ý:
  - Request này không tạo key mới: dùng lại key của bước nạp tiền.

### Bước 11 — Số dư vẫn 150000 sau khi gửi lại

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi gửi lại cùng key: tiền không được cộng lần hai.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

## Kiểm tra cuối luồng

- Số dư ví = `150000` và bằng tổng sổ cái.
- Payment có đúng một charge `SUCCEEDED` 150000 VND với `reference` là id topup.
- Gửi lại cùng key trả cùng `topupId`, số dư không đổi.
