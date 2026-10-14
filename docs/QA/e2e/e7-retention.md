# E7 — Retention không chạm dữ liệu tài chính

## Mục tiêu

Kiểm tra khi bật xóa thật của job retention (`RETENTION_DRY_RUN=false`) trên dữ liệu mới thì dữ liệu tài chính (ví, sổ cái, topup, charge) **không đổi**. Postman chụp "ảnh" dữ liệu trước và đối chiếu sau; phần đổi cấu hình, quan sát log/Kibana là thao tác tay vì Postman không đổi được cấu hình service.

Dữ liệu mới dựng luôn trẻ hơn mọi ngưỡng xóa nên luồng này không xóa dòng nào; đây là cách C trong [`../test-case/retention-quan-sat.md`](../test-case/retention-quan-sat.md).

- Service tham gia: wallet, payment.
- Có phần tiêm lỗi hoặc tạo lỗi: có.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe.
- Xóa thật **không hoàn tác**: chỉ làm trên local stack với dữ liệu thử.
- Sửa được `deploy/compose.services.yml` và chạy `docker compose` từ thư mục gốc repo; **trả lại giá trị gốc trước khi commit**.
- Dùng **Postman app Runner** hoặc **Newman** (cần giữ biến giữa hai phần). Postman CLI không giữ biến giữa các lần chạy nên **không dùng** cho luồng này.

## Cách chạy

| Phần | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| P1 Chụp dữ liệu trước | 8 | 8 request (wallet 6, payment 2) | `bee7f970-d32d-5289-a128-551ad04d4edd` |
| P2 Đối chiếu sau | 6 | 6 request (wallet 4, payment 2) | `86181ff1-83a2-576d-a4c0-1739e701b959` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải từng folder phần > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 30 giây cho phần dài nhất.

**Không chạy cả folder `E7 Retention không chạm dữ liệu tài chính` một lần.** Luồng này có thao tác tay xen giữa các phần; chạy từng phần theo đúng thứ tự trong bảng "Các bước", làm thao tác tay ở giữa.

**Chạy bằng Newman** (cần giữ biến giữa các phần; Postman CLI không giữ biến giữa các lần chạy nên không dùng):

```bash
npx newman run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  --export-environment e2e-state.json --folder bee7f970-d32d-5289-a128-551ad04d4edd   # P1 Chụp dữ liệu trước
# các phần sau: thay -e bằng e2e-state.json, giữ --export-environment e2e-state.json, đổi --folder sang id phần kế tiếp
```

## Các phần

### Phần P1 Chụp dữ liệu trước

Tạo dữ liệu mới và ghi lại số dư, số entry, trạng thái topup, charge.

- Gồm các bước: 1 đến 8.
- Trước phần này: không có thao tác tay.
- Sau phần này: Bước 9 (thao tác tay: Ghi số dòng các bảng tài chính trước (tùy chọn)); Bước 10 (thao tác tay: Bật xóa thật cho wallet, chờ một lượt, rồi cho payment).

### Phần P2 Đối chiếu sau

Sau khi retention chạy xóa thật, dữ liệu tài chính còn nguyên.

- Gồm các bước: 11 đến 16.
- Trước phần này: làm Bước 9 (thao tác tay: Ghi số dòng các bảng tài chính trước (tùy chọn)); làm Bước 10 (thao tác tay: Bật xóa thật cho wallet, chờ một lượt, rồi cho payment).
- Sau phần này: Bước 17 (thao tác tay: Trả lại cấu hình retention).

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E7-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E7-02 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 3 | Tay hoặc Runner | `E7-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Tay hoặc Runner | `E7-04 Yêu cầu nạp 150000` | `202`; `status` `REQUESTED`, `amount` 150000, `currency` `VND`. |
| 5 | Poll (tay: gửi lại; Runner: tự lặp) | `E7-05 Poll topup đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 6 | Tay hoặc Runner | `E7-06 Chụp số dư và sổ cái trước` | `200`; đúng 1 entry topup 150000. |
| 7 | Tay hoặc Runner | `E7-07 Chụp số dư trước = 150000` | `200`; `balance` `150000`. |
| 8 | Tay hoặc Runner | `E7-08 Chụp charge trong sao kê trước` | `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`. |
| 9 | Thao tác tay | Ghi số dòng các bảng tài chính trước (tùy chọn) | Xem Bước 9 ở phần chi tiết |
| 10 | Thao tác tay | Bật xóa thật cho wallet, chờ một lượt, rồi cho payment | Xem Bước 10 ở phần chi tiết |
| 11 | Tay hoặc Runner | `E7-11 Wallet health sau khi bật xóa thật` | `200`, `{"status":"ok","service":"wallet"}`. |
| 12 | Tay hoặc Runner | `E7-12 Payment health sau khi bật xóa thật` | `200`, `{"status":"ok","service":"payment"}`. |
| 13 | Tay hoặc Runner | `E7-13 Số dư sau = số dư trước` | `200`; `balance` `150000`. |
| 14 | Tay hoặc Runner | `E7-14 Sổ cái sau = sổ cái trước` | `200`; số entry và tổng `amount` bằng `e2e_snap_entries` và `e2e_snap_sum`. |
| 15 | Tay hoặc Runner | `E7-15 Topup còn đọc được` | `200`; `status` `SUCCEEDED`, `amount` `150000`. |
| 16 | Tay hoặc Runner | `E7-16 Charge còn trong sao kê sau` | `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`. |
| 17 | Thao tác tay | Trả lại cấu hình retention | Xem Bước 17 ở phần chi tiết |

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

### Bước 6 — Chụp số dư và sổ cái trước

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Ghi lại số entry và tổng sổ cái của ví trước khi bật xóa thật.
- Kết quả mong đợi: `200`; đúng 1 entry topup 150000.
- Biến: Ghi: `e2e_snap_entries`, `e2e_snap_sum`. Đọc: `e2e_cust`, `e2e_topup_id`.

### Bước 7 — Chụp số dư trước = 150000

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Ghi lại số dư của ví trước khi bật xóa thật.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 8 — Chụp charge trong sao kê trước

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge có `reference` bằng id topup (wallet dùng id topup làm `reference` khi gửi charge sang payment).
- Kết quả mong đợi: `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`.
- Biến: Đọc: `e2e_today`, `e2e_topup_id`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp so với `e2e_today`: chạy lại luồng sau nửa đêm.

### Bước 9 — Ghi số dòng các bảng tài chính trước (tùy chọn) (thao tác tay)

1. Dùng truy vấn **chỉ đọc** theo mục "Chuẩn bị" của [`../test-case/retention-quan-sat.md`](../test-case/retention-quan-sat.md) để đếm: wallet (schema theo tenant) `ledger_entries`, `ledger_transactions`, `accounts`, `topups`, `order_payments`; payment `charges`.
2. Ghi lại các số này để so sánh ở bước sau.

### Bước 10 — Bật xóa thật cho wallet, chờ một lượt, rồi cho payment (thao tác tay)

1. Trong `deploy/compose.services.yml`, đặt `RETENTION_DRY_RUN: 'false'` ở mục `environment` của `wallet`.
2. Chạy: `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d wallet`.
3. Lượt retention đầu chạy ngay khi service khởi động. Xem log: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment | grep -E "retention (run finished|policy failed|run failed)"`. Log `retention run finished` chỉ xuất hiện khi có dòng được xóa hoặc có lỗi, nên **không có log** là bình thường với dữ liệu mới. Kiểm tra gauge "Retention: số giây từ lần chạy thành công gần nhất" trên Kibana (dashboard "Billing: vận hành") được làm mới.
4. Làm tương tự cho `payment` (đặt `RETENTION_DRY_RUN: 'false'` ở mục của `payment`, `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d payment`).
5. Chạy phần **P2**.

### Bước 11 — Wallet health sau khi bật xóa thật

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/health`
- Làm gì: Kiểm tra wallet khỏe sau khi tạo lại container. **Không** tạo lượt chạy mới (giữ nguyên biến của P1).
- Kết quả mong đợi: `200`, `{"status":"ok","service":"wallet"}`.
- Biến: Không đọc/ghi biến.

### Bước 12 — Payment health sau khi bật xóa thật

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/health`
- Làm gì: Kiểm tra payment khỏe sau khi tạo lại container.
- Kết quả mong đợi: `200`, `{"status":"ok","service":"payment"}`.
- Biến: Không đọc/ghi biến.

### Bước 13 — Số dư sau = số dư trước

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi bật xóa thật.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 14 — Sổ cái sau = sổ cái trước

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: số entry và tổng giống ảnh chụp trước.
- Kết quả mong đợi: `200`; số entry và tổng `amount` bằng `e2e_snap_entries` và `e2e_snap_sum`.
- Biến: Đọc: `e2e_cust`, `e2e_snap_entries`, `e2e_snap_sum`, `e2e_topup_id`.

### Bước 15 — Topup còn đọc được

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Đọc lại topup sau khi bật xóa thật.
- Kết quả mong đợi: `200`; `status` `SUCCEEDED`, `amount` `150000`.
- Biến: Đọc: `e2e_topup_id`, `e2e_cust`.

### Bước 16 — Charge còn trong sao kê sau

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge có `reference` bằng id topup (wallet dùng id topup làm `reference` khi gửi charge sang payment).
- Kết quả mong đợi: `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`.
- Biến: Đọc: `e2e_today`, `e2e_topup_id`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp so với `e2e_today`: chạy lại luồng sau nửa đêm.

### Bước 17 — Trả lại cấu hình retention (thao tác tay)

1. Đặt lại `RETENTION_DRY_RUN: 'true'` cho cả hai service, chạy `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d wallet payment`. **Trả lại giá trị gốc trước khi commit.**
2. Tùy chọn: đếm lại các bảng tài chính như ở bước trước; các số phải **không đổi**.

## Kiểm tra cuối luồng

- Số dư, số entry, tổng sổ cái, topup và charge sau khi bật xóa thật giống hệt ảnh chụp trước.
- Cấu hình `RETENTION_DRY_RUN` đã trả về `true`.

## Lưu ý khi tiêm lỗi

- Bật xóa thật làm tạo lại container của `wallet` và `payment`; chỉ làm trên local stack.
- Chỉ làm trên local stack với dữ liệu thử.
