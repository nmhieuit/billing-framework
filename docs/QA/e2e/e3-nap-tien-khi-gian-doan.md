# E3 — Nạp tiền khi service gián đoạn

## Mục tiêu

Kiểm tra tiền vẫn được cộng **đúng một lần** khi một service ngừng giữa lúc nạp tiền.

Kịch bản A: payment ngừng lúc wallet đang gửi charge (wallet thử lại theo backoff, topup hồi phục khi payment lên lại).

Kịch bản B: wallet tạm đóng băng tiến trình (pause) lúc payment gửi webhook (payment gửi lại theo backoff).

- Service tham gia: wallet, payment.
- Có phần tiêm lỗi hoặc tạo lỗi: có.

## Điều kiện tiên quyết

- Stack local đã lên và khỏe.
- Chạy được `docker compose` trên máy chạy stack, từ thư mục gốc repo.
- Dùng **Postman app Runner** hoặc **Newman** (cần giữ biến giữa các phần). Postman CLI không giữ biến giữa các lần chạy nên **không dùng** cho luồng này.
- Chỉ làm trên local stack với dữ liệu thử.

## Cách chạy

| Phần | Số bước có request | Tải lên stack | Id folder |
| --- | --- | --- | --- |
| A1 Chuẩn bị ví | 3 | 3 request (wallet 2, payment 1) | `dbb6bb17-516d-5971-abb5-25854c168f98` |
| A2 Nạp tiền khi payment ngừng | 3 | 3 request (wallet 3) | `fa998b7b-1733-54ac-acf1-adb8223c0496` |
| A3 Hồi phục sau khi payment lên lại | 7 | 7 request (wallet 5, payment 2) | `2ecb5ff7-be65-5e2a-aff7-88df78a9a08e` |
| B1 Nạp tiền để tiêm lỗi wallet | 1 | 1 request (wallet 1) | `676740a0-b005-50e4-ae6c-02ab1fd00186` |
| B2 Hồi phục sau khi wallet chạy lại | 4 | 4 request (wallet 3, payment 1) | `7df44186-1a0f-5cf8-adca-ed6365a1bd62` |

**Chạy tay từng request:** mở folder, gửi lần lượt từng request theo số bước. Mỗi bước có hướng dẫn trong tab Docs của request. Request loại "Poll" thì gửi lại cho đến khi có trạng thái cuối (chạy tay không tự lặp).

**Chạy Runner (Postman app):** chuột phải từng folder phần > **Run**; giữ thứ tự mặc định, Iterations `1`, Delay `0 ms`, bật tùy chọn giữ giá trị biến sau khi chạy (Keep variable values) để phần sau đọc được biến của phần trước. Runner gửi tuần tự từng request một, không song song, nên tải lên stack chỉ là số request ở bảng trên. Các request Poll tự lặp, mỗi lần cách `poll_interval_ms` (mặc định 1000 ms), tối đa `e2e_poll_max_attempts` (30) hoặc `e2e_recovery_max_attempts` (180) lần; thời gian chờ tối đa thêm khoảng 180 giây cho phần dài nhất.

**Không chạy cả folder `E3 Nạp tiền khi service gián đoạn` một lần.** Luồng này có thao tác tay xen giữa các phần; chạy từng phần theo đúng thứ tự trong bảng "Các bước", làm thao tác tay ở giữa.

**Chạy bằng Newman** (cần giữ biến giữa các phần; Postman CLI không giữ biến giữa các lần chạy nên không dùng):

```bash
npx newman run docs/QA/postman/billing.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  --export-environment e2e-state.json --folder dbb6bb17-516d-5971-abb5-25854c168f98   # A1 Chuẩn bị ví
# các phần sau: thay -e bằng e2e-state.json, giữ --export-environment e2e-state.json, đổi --folder sang id phần kế tiếp
```

## Các phần

### Phần A1 Chuẩn bị ví

Tạo ví cho kịch bản A.

- Gồm các bước: 1 đến 3.
- Trước phần này: không có thao tác tay.
- Sau phần này: Bước 4 (thao tác tay: Dừng payment (kịch bản A)).

### Phần A2 Nạp tiền khi payment ngừng

Gửi yêu cầu nạp khi payment đang ngừng và xác nhận topup chưa hoàn tất.

- Gồm các bước: 5 đến 7.
- Trước phần này: làm Bước 4 (thao tác tay: Dừng payment (kịch bản A)).
- Sau phần này: Bước 8 (thao tác tay: Chờ rồi khởi động lại payment).

### Phần A3 Hồi phục sau khi payment lên lại

Xác nhận topup tự hồi phục và tiền được cộng đúng một lần.

- Gồm các bước: 9 đến 15.
- Trước phần này: làm Bước 8 (thao tác tay: Chờ rồi khởi động lại payment).
- Sau phần này: không có thao tác tay.

### Phần B1 Nạp tiền để tiêm lỗi wallet

Gửi một yêu cầu nạp thứ hai; ngay sau đó QA tạm dừng wallet bằng tay.

- Gồm các bước: 16.
- Trước phần này: không có thao tác tay.
- Sau phần này: Bước 17 (thao tác tay: Tạm dừng wallet (kịch bản B)).

### Phần B2 Hồi phục sau khi wallet chạy lại

Xác nhận topup thứ hai về `SUCCEEDED`, tiền cộng đúng một lần cho mỗi topup.

- Gồm các bước: 18 đến 21.
- Trước phần này: làm Bước 17 (thao tác tay: Tạm dừng wallet (kịch bản B)).
- Sau phần này: không có thao tác tay.

## Các bước

| Bước | Loại | Request / thao tác | Kết quả mong đợi |
| --- | --- | --- | --- |
| 1 | Tay hoặc Runner | `E3-01 Wallet health và khởi tạo lượt chạy` | `200`, `{"status":"ok","service":"wallet"}`. |
| 2 | Tay hoặc Runner | `E3-02 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 3 | Tay hoặc Runner | `E3-03 Tạo ví VND` | `201`; `currency` `VND`, `balance` `0`. |
| 4 | Thao tác tay | Dừng payment (kịch bản A) | Xem Bước 4 ở phần chi tiết |
| 5 | Tay hoặc Runner | `E3-05 Yêu cầu nạp 150000 khi payment ngừng` | `202`; `status` `REQUESTED`. |
| 6 | Tay hoặc Runner | `E3-06 Topup chưa hoàn tất khi payment ngừng` | `200`; `status` vẫn `REQUESTED`. |
| 7 | Tay hoặc Runner | `E3-07 Số dư vẫn 0 khi payment ngừng` | `200`; `balance` `0`. |
| 8 | Thao tác tay | Chờ rồi khởi động lại payment | Xem Bước 8 ở phần chi tiết |
| 9 | Tay hoặc Runner | `E3-09 Payment health` | `200`, `{"status":"ok","service":"payment"}`. |
| 10 | Poll (tay: gửi lại; Runner: tự lặp) | `E3-10 Poll topup đến SUCCEEDED sau khi payment lên lại` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 11 | Tay hoặc Runner | `E3-11 Số dư = 150000 sau hồi phục` | `200`; `balance` `150000`. |
| 12 | Tay hoặc Runner | `E3-12 Sổ cái có đúng 1 entry topup` | `200`; tổng `amount` = `150000`; đúng 1 entry `topup:<topupId>`. |
| 13 | Tay hoặc Runner | `E3-13 Payment chỉ có 1 charge cho topup` | `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`. |
| 14 | Tay hoặc Runner | `E3-14 Gửi lại cùng Idempotency-Key sau hồi phục` | `202`; trả về **cùng `topupId`** với lần đầu, không tạo topup mới. |
| 15 | Tay hoặc Runner | `E3-15 Số dư vẫn 150000 sau khi gửi lại` | `200`; `balance` `150000`. |
| 16 | Tay hoặc Runner | `E3-16 Yêu cầu nạp 100000 (kịch bản B)` | `202`; `status` `REQUESTED`. |
| 17 | Thao tác tay | Tạm dừng wallet (kịch bản B) | Xem Bước 17 ở phần chi tiết |
| 18 | Poll (tay: gửi lại; Runner: tự lặp) | `E3-18 Poll topup B đến SUCCEEDED` | `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`. |
| 19 | Tay hoặc Runner | `E3-19 Số dư = 250000` | `200`; `balance` `250000`. |
| 20 | Tay hoặc Runner | `E3-20 Sổ cái có đúng 2 entry topup` | `200`; tổng `amount` = `250000`; mỗi topup đúng 1 entry; tổng cộng 2 entry topup. |
| 21 | Tay hoặc Runner | `E3-21 Payment chỉ có 1 charge cho topup B` | `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 100000, `currency` `VND`. |

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

### Bước 4 — Dừng payment (kịch bản A) (thao tác tay)

1. Chạy: `docker compose -f deploy/compose.local.yml --env-file deploy/.env stop payment`.
2. Kiểm tra payment đã dừng: `docker compose -f deploy/compose.local.yml --env-file deploy/.env ps payment` không còn trạng thái chạy, và `GET http://localhost:3002/health` không trả lời.
3. Chỉ sau đó mới chạy phần **A2**.

### Bước 5 — Yêu cầu nạp 150000 khi payment ngừng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi yêu cầu nạp 150000 VND trong lúc payment đang ngừng. Wallet vẫn nhận yêu cầu.
- Kết quả mong đợi: `202`; `status` `REQUESTED`.
- Biến: Ghi: `e2e_topup_key`, `e2e_topup_id`, `e2e_topup_id_a`. Đọc: `e2e_cust`.

### Bước 6 — Topup chưa hoàn tất khi payment ngừng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Đọc topup trong lúc payment còn ngừng: wallet đang thử lại theo backoff nên topup chưa kết thúc.
- Kết quả mong đợi: `200`; `status` vẫn `REQUESTED`.
- Biến: Đọc: `e2e_topup_id`, `e2e_cust`.
- Lưu ý:
  - Nếu payment ngừng quá tổng thời gian backoff (khoảng 756 giây) thì topup sang `FAILED` với `failureCode` `PAYMENT_UNAVAILABLE`.

### Bước 7 — Số dư vẫn 0 khi payment ngừng

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư: chưa có tiền vì chưa có webhook thành công.
- Kết quả mong đợi: `200`; `balance` `0`.
- Biến: Đọc: `e2e_cust`.

### Bước 8 — Chờ rồi khởi động lại payment (thao tác tay)

1. Chờ khoảng 10 giây sau khi chạy xong phần **A2** (wallet đã thử gửi và thất bại ít nhất một lần).
2. Chạy: `docker compose -f deploy/compose.local.yml --env-file deploy/.env start payment`.
3. Chờ `GET http://localhost:3002/health` trả `ok`.
4. Khởi động lại sớm: payment ngừng quá tổng thời gian backoff (khoảng 756 giây) thì topup sang `FAILED` và kịch bản A không còn đúng; khi đó chạy lại luồng từ đầu.
5. Sau đó chạy phần **A3**.

### Bước 9 — Payment health

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/health`
- Làm gì: Kiểm tra payment khỏe.
- Kết quả mong đợi: `200`, `{"status":"ok","service":"payment"}`.
- Biến: Không đọc/ghi biến.

### Bước 10 — Poll topup đến SUCCEEDED sau khi payment lên lại

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id}}`
- Làm gì: Chờ topup có trạng thái cuối. Chạy tay: gửi lại request mỗi 1-2 giây cho đến khi `status` là `SUCCEEDED`. Runner: tự lặp tối đa `e2e_recovery_max_attempts` lần, mỗi lần cách `poll_interval_ms`.
- Kết quả mong đợi: `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`.
- Biến: Đọc: `e2e_topup_id`, `e2e_recovery_max_attempts`, `poll_interval_ms`.
- Lưu ý:
  - Chờ tối đa `e2e_recovery_max_attempts` lần (mặc định 180, khoảng 3 phút) vì wallet thử lại theo backoff `1,5,30,120,600` giây.

### Bước 11 — Số dư = 150000 sau hồi phục

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi topup `SUCCEEDED`.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 12 — Sổ cái có đúng 1 entry topup

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: tiền chỉ cộng một lần.
- Kết quả mong đợi: `200`; tổng `amount` = `150000`; đúng 1 entry `topup:<topupId>`.
- Biến: Đọc: `e2e_cust`.

### Bước 13 — Payment chỉ có 1 charge cho topup

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge có `reference` bằng id topup (wallet dùng id topup làm `reference` khi gửi charge sang payment).
- Kết quả mong đợi: `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 150000, `currency` `VND`.
- Biến: Đọc: `e2e_today`, `e2e_topup_id`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp so với `e2e_today`: chạy lại luồng sau nửa đêm.

### Bước 14 — Gửi lại cùng Idempotency-Key sau hồi phục

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi lại đúng yêu cầu nạp ở trên (cùng `Idempotency-Key`, cùng nội dung).
- Kết quả mong đợi: `202`; trả về **cùng `topupId`** với lần đầu, không tạo topup mới.
- Biến: Đọc: `e2e_topup_key`, `e2e_topup_id`.
- Lưu ý:
  - Request này không tạo key mới: dùng lại key của bước nạp tiền.

### Bước 15 — Số dư vẫn 150000 sau khi gửi lại

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau khi gửi lại cùng key.
- Kết quả mong đợi: `200`; `balance` `150000`.
- Biến: Đọc: `e2e_cust`.

### Bước 16 — Yêu cầu nạp 100000 (kịch bản B)

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `POST {{wallet_base_url}}/topups`
- Làm gì: Gửi yêu cầu nạp 100000 VND (topup thứ hai của ví). Ngay sau khi nhận `202`, thực hiện thao tác tay kế tiếp (tạm dừng wallet).
- Kết quả mong đợi: `202`; `status` `REQUESTED`.
- Biến: Ghi: `e2e_topup_key_b`, `e2e_topup_id_b`. Đọc: `e2e_cust`.

### Bước 17 — Tạm dừng wallet (kịch bản B) (thao tác tay)

1. Ngay sau khi phần **B1** nhận `202`, chạy: `docker compose -f deploy/compose.local.yml --env-file deploy/.env pause wallet`.
2. Giữ wallet bị tạm dừng khoảng 15 đến 20 giây.
3. Chạy: `docker compose -f deploy/compose.local.yml --env-file deploy/.env unpause wallet`.
4. Chờ `GET http://localhost:3001/health` trả `ok`.
5. Sau đó chạy phần **B2**.
6. Thời điểm pause quyết định wallet hay payment phải thử lại; kết quả cuối (topup `SUCCEEDED`, tiền cộng một lần) không đổi.

### Bước 18 — Poll topup B đến SUCCEEDED

- Loại: Poll: chạy tay thì gửi lại cho đến khi có trạng thái cuối; Runner tự lặp.
- Request: `GET {{wallet_base_url}}/topups/{{e2e_topup_id_b}}`
- Làm gì: Chờ topup có trạng thái cuối. Chạy tay: gửi lại request mỗi 1-2 giây cho đến khi `status` là `SUCCEEDED`. Runner: tự lặp tối đa `e2e_recovery_max_attempts` lần, mỗi lần cách `poll_interval_ms`.
- Kết quả mong đợi: `200`; cuối cùng `status` `SUCCEEDED`, có `completedAt`.
- Biến: Đọc: `e2e_topup_id_b`, `e2e_recovery_max_attempts`, `poll_interval_ms`.
- Lưu ý:
  - Chờ tối đa `e2e_recovery_max_attempts` lần: payment gửi lại webhook theo backoff `1,5,30,120,600` giây nên có thể mất vài chục giây.

### Bước 19 — Số dư = 250000

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet`
- Làm gì: Đọc số dư sau hai lần nạp (150000 + 100000).
- Kết quả mong đợi: `200`; `balance` `250000`.
- Biến: Đọc: `e2e_cust`.

### Bước 20 — Sổ cái có đúng 2 entry topup

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{wallet_base_url}}/wallet/entries?limit=1000`
- Làm gì: Đọc sổ cái: mỗi topup chỉ có một entry.
- Kết quả mong đợi: `200`; tổng `amount` = `250000`; mỗi topup đúng 1 entry; tổng cộng 2 entry topup.
- Biến: Đọc: `e2e_cust`, `e2e_topup_id_a`, `e2e_topup_id_b`.

### Bước 21 — Payment chỉ có 1 charge cho topup B

- Loại: Chạy tay hoặc Runner (gửi một lần).
- Request: `GET {{payment_base_url}}/settlements?date={{e2e_today}}&limit=1000`
- Làm gì: Đọc sao kê payment của ngày UTC hôm nay và tìm charge có `reference` bằng id topup (wallet dùng id topup làm `reference` khi gửi charge sang payment).
- Kết quả mong đợi: `200`; đúng 1 charge có `reference` = id topup, `status` `SUCCEEDED`, `amount` 100000, `currency` `VND`.
- Biến: Đọc: `e2e_today`, `e2e_topup_id_b`.
- Lưu ý:
  - Gần nửa đêm UTC, charge có thể rơi sang ngày kế tiếp so với `e2e_today`: chạy lại luồng sau nửa đêm.

## Kiểm tra cuối luồng

- Cả hai topup `SUCCEEDED`; số dư ví `250000` và bằng tổng sổ cái.
- Mỗi topup có đúng một entry và đúng một charge ở payment.
- Gửi lại cùng key trả cùng `topupId`.

## Lưu ý khi tiêm lỗi

- Kịch bản A dùng `stop`/`start` để payment từ chối kết nối; kịch bản B dùng `pause`/`unpause` để wallet treo mà không mất kết nối.
- Sau khi chạy xong, kiểm tra cả hai service `running`: `docker compose -f deploy/compose.local.yml --env-file deploy/.env ps`.
- Chỉ làm trên local stack với dữ liệu thử.
