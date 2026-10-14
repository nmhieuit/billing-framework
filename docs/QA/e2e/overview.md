# E2E liên service: tổng quan

Bộ luồng e2e chạy các nghiệp vụ trọn vẹn đi qua nhiều service (wallet, payment, RabbitMQ) trên local stack. Mỗi luồng có một folder trong collection Postman (folder `E2E`), một file hướng dẫn chạy theo thứ tự và, nếu cần, hướng dẫn tiêm lỗi từng bước. Nội dung hướng dẫn trong file md và trong tab Docs của Postman là cùng một nội dung.

## Các luồng

| Luồng | Nghiệp vụ | Service | Tiêm lỗi / tạo lỗi | Số request | Hướng dẫn |
| --- | --- | --- | --- | --- | --- |
| E1 | Nạp tiền thành công | wallet, payment | Không | 11 | [`e1-nap-tien-thanh-cong.md`](e1-nap-tien-thanh-cong.md) |
| E2 | Nạp tiền thất bại (payment từ chối) | wallet, payment | Có | 8 | [`e2-nap-tien-that-bai.md`](e2-nap-tien-that-bai.md) |
| E3 | Nạp tiền khi service gián đoạn | wallet, payment | Có | 18 | [`e3-nap-tien-khi-gian-doan.md`](e3-nap-tien-khi-gian-doan.md) |
| E4 | Thanh toán order qua RabbitMQ | wallet, RabbitMQ (qua management API) | Không | 20 | [`e4-thanh-toan-order-rabbitmq.md`](e4-thanh-toan-order-rabbitmq.md) |
| E5 | Vận hành trên ví đã có tiền | wallet, RabbitMQ (qua management API) | Không | 26 | [`e5-van-hanh-tren-vi-co-tien.md`](e5-van-hanh-tren-vi-co-tien.md) |
| E6 | Đối soát sau giao dịch | wallet, payment | Không | 16 | [`e6-doi-soat-sau-giao-dich.md`](e6-doi-soat-sau-giao-dich.md) |
| E7 | Retention không chạm dữ liệu tài chính | wallet, payment | Có | 14 | [`e7-retention.md`](e7-retention.md) |

Thứ tự nên chạy: E1, E2, E4, E5, E6 trước (không đổi cấu hình hạ tầng); E3 và E7 sau cùng vì phải dừng/tạm dừng service hoặc đổi cấu hình retention.

## Sơ đồ ngắn

```text
E1  QA ─▶ wallet ─▶ payment ─▶ webhook ─▶ wallet (cộng ví, ghi sổ cái) ─▶ kiểm số dư, sổ cái, sao kê
E2  QA ─▶ payment (charge fail=card_declined) ─▶ webhook ─▶ wallet ─▶ kiểm ví không đổi
E3  như E1 + (dừng payment) hoặc (tạm dừng wallet) giữa chừng ─▶ hồi phục, tiền cộng một lần
E4  QA (vai ecommerce) ─▶ RabbitMQ orders.events ─▶ wallet (trừ ví) ─▶ billing.events ─▶ queue kết quả ─▶ QA đọc
E5  E4 + ops freeze/unfreeze, replay-paid, adjust, reverse, nhật ký
E6  giao dịch ─▶ đối soát hôm nay ─▶ không lệch; (tùy chọn) charge mồ côi ─▶ ca UNKNOWN_CHARGE
E7  chụp dữ liệu ─▶ bật xóa thật retention ─▶ dữ liệu tài chính không đổi
```

## Cách dùng chung

1. Dựng môi trường theo [`../moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md); import `postman/billing.postman_collection.json` và `postman/billing-local.postman_environment.json`, chọn environment `billing-local`.
2. Chọn luồng, mở file hướng dẫn tương ứng và làm theo bảng "Các bước". Mỗi bước nói rõ **chạy tay** hay **Runner**.
3. **Chạy tay:** gửi từng request theo số bước. Request loại Poll thì gửi lại cho đến khi có trạng thái cuối.
4. **Chạy Runner:** chạy cả folder luồng (hoặc từng folder phần nếu luồng có thao tác tay xen giữa). Runner gửi tuần tự, không song song.
5. Các luồng có nhiều phần (E3, E7) giữ trạng thái trong biến environment `e2e_*`: dùng Postman app Runner hoặc Newman với `--export-environment`. Postman CLI không giữ biến giữa các lần chạy.

## Biến environment dùng cho e2e

Các biến mới có tiền tố `e2e_`, thêm vào environment `billing-local`; collection cũ vẫn chạy bình thường vì không dùng các biến này.

| Biến | Giá trị mặc định | Ý nghĩa |
| --- | --- | --- |
| `e2e_rabbitmq_url` | `http://localhost:15674` | URL RabbitMQ management (`LOCAL_RABBITMQ_MGMT_PORT` trong `deploy/.env`) |
| `e2e_rabbitmq_vhost` | `billing` | vhost RabbitMQ |
| `e2e_rabbitmq_user` | điền từ `deploy/.env` | Tài khoản quản trị RabbitMQ (`BILLING_RABBITMQ_ADMIN_USER` trong `deploy/.env`) |
| `e2e_rabbitmq_password` | điền từ `deploy/.env`, kiểu secret | Mật khẩu quản trị RabbitMQ (`BILLING_RABBITMQ_ADMIN_PASSWORD` trong `deploy/.env`) |
| `e2e_results_queue` | `ecommerce.e2e-results` | Queue nhận kết quả, đóng vai consumer của ecommerce |
| `e2e_poll_max_attempts` | `30` | Số lần poll tối đa cho các bước chờ thông thường (mỗi lần cách `poll_interval_ms`) |
| `e2e_recovery_max_attempts` | `180` | Số lần poll tối đa cho các bước chờ hồi phục sau tiêm lỗi (E3) |

Biến trạng thái chạy (`e2e_run`, `e2e_cust`, `e2e_topup_id`, `e2e_order_id`...) do script đặt; không sửa tay. Biến cũ đang dùng chung: `wallet_base_url`, `payment_base_url`, `tenant_id`, `actor_id`, `actor_role`, `poll_interval_ms`, `reconciliation_resolve_enabled`.

## Id folder

Dùng với `postman collection run -i <id>` hoặc `newman --folder <id>`.

| Folder | Id |
| --- | --- |
| E1 Nạp tiền thành công | `7f6d4192-dcea-5d96-a985-31eb6233e75b` |
| E2 Nạp tiền thất bại (payment từ chối) | `935c6dcb-3fc5-54e0-a797-89d86c2a3ba7` |
| E3 Nạp tiền khi service gián đoạn | `04b0617c-d0fa-55a2-ae31-bf62fbb63481` |
| E3 > A1 Chuẩn bị ví | `dbb6bb17-516d-5971-abb5-25854c168f98` |
| E3 > A2 Nạp tiền khi payment ngừng | `fa998b7b-1733-54ac-acf1-adb8223c0496` |
| E3 > A3 Hồi phục sau khi payment lên lại | `2ecb5ff7-be65-5e2a-aff7-88df78a9a08e` |
| E3 > B1 Nạp tiền để tiêm lỗi wallet | `676740a0-b005-50e4-ae6c-02ab1fd00186` |
| E3 > B2 Hồi phục sau khi wallet chạy lại | `7df44186-1a0f-5cf8-adca-ed6365a1bd62` |
| E4 Thanh toán order qua RabbitMQ | `4cca8188-dbdb-5ada-acc8-530e0fde919e` |
| E5 Vận hành trên ví đã có tiền | `fb5257d2-928c-5428-a494-9d08d22f6b2d` |
| E6 Đối soát sau giao dịch | `7d149073-658a-5225-a130-d1a56e9834e6` |
| E6 > Phần 1 Đối soát không lệch | `cd22d9e7-59c7-581f-a970-91a1e8c9c6c8` |
| E6 > Phần 2 Dựng ca lệch UNKNOWN_CHARGE (tùy chọn) | `0e65bb0e-d2b6-501c-ab90-90b2e9064aff` |
| E7 Retention không chạm dữ liệu tài chính | `d14bc66c-fca1-5d0b-a37c-c533a0565dbe` |
| E7 > P1 Chụp dữ liệu trước | `bee7f970-d32d-5289-a128-551ad04d4edd` |
| E7 > P2 Đối chiếu sau | `86181ff1-83a2-576d-a4c0-1739e701b959` |

## Lưu ý chung

- Mọi luồng ghi dữ liệu thật vào DB local (ví, topup, charge, sổ cái, nhật ký ops). Chỉ chạy trên local stack.
- Luồng E4 và E5 tạo queue `ecommerce.e2e-results` ở RabbitMQ và để lại sau khi chạy.
- Gần nửa đêm UTC các bước dùng sao kê hoặc đối soát theo ngày có thể lệch ngày: chạy lại sau nửa đêm.
