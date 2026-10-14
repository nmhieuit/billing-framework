# Môi trường và dữ liệu test

Mọi test case trong tài liệu này chạy trên **local stack**. Không trỏ vào môi trường dùng chung. Mỗi lần test ghi dữ liệu thật vào DB local (ví, topup, charge, sổ cái, nhật ký ops, lượt đối soát) và không tự được dọn.

## 1. Dựng môi trường

1. Tạo `deploy/.env` từ `deploy/.env.example` và điền các giá trị.
2. Dựng stack:

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build
```

3. Chờ các job `migrate` và `*-init` thoát mã 0.
4. Kiểm tra hai service khỏe:

| Service | URL mặc định | Đổi bằng biến | `GET /health` trả về |
| --- | --- | --- | --- |
| Wallet | `http://localhost:3001` | `LOCAL_WALLET_PORT` | `{"status":"ok","service":"wallet"}` |
| Payment | `http://localhost:3002` | `LOCAL_PAYMENT_PORT` | `{"status":"ok","service":"payment"}` |

Các công cụ quan sát đi kèm: Kibana `http://localhost:15601`, RabbitMQ management `http://localhost:15674` (đổi bằng `LOCAL_RABBITMQ_MGMT_PORT`).

## 2. Quy ước chung

| Hạng mục | Giá trị |
| --- | --- |
| Tenant hợp lệ | `acme`, `beta` (mặc định của `LOCAL_TENANTS`). Tenant khác bị từ chối |
| Đồng tiền | `VND`, `USD`. Số tiền là **số nguyên đơn vị nhỏ nhất** |
| Danh tính | Không có token. QA **tự đặt header**: `x-tenant-id`, `x-customer-id`; riêng `/ops` thêm `x-actor-id` và `x-actor-role: OPS` |
| Customer id | Chữ, số, `_` hoặc `-`, 1 đến 64 ký tự. Mỗi test dùng customer id **mới** để dữ liệu không dính nhau |
| `Idempotency-Key` | Mỗi test dùng key **mới**, trừ case cố ý gửi lại |
| Dạng lỗi | `{"error":{"code":"...","message":"..."}}` |
| Nạp tiền | **Bất đồng bộ**: `POST /topups` luôn trả `202`; cộng tiền khi webhook từ payment về. Sau khi gọi, chờ vài giây và lặp `GET /topups/{id}` đến khi `status` là `SUCCEEDED` hoặc `FAILED` |
| Webhook payment sang wallet | Đã nối sẵn trong stack, dùng chung secret `LOCAL_WEBHOOK_SECRET` |

Ví dụ biến dùng trong các lệnh `curl`:

```bash
W=http://localhost:3001
H='-H x-tenant-id:acme -H x-customer-id:qa-c001 -H content-type:application/json'
```

## 3. Dữ liệu mẫu

- Dùng lệnh `pnpm local:seed` nếu cần dữ liệu mẫu (ví, topup, đối soát, queue nhận kết quả cho order). Lệnh này tạo thêm dữ liệu, nên chạy **trước** khi test đối soát sạch hoặc bỏ qua nếu cần dữ liệu sạch.
- Với test thủ công, tự tạo dữ liệu bằng chính các endpoint (xem [`test-case/wallet.md`](test-case/wallet.md)).

## 4. Biến cần có trước khi chạy Postman

File environment: [`postman/billing-local.postman_environment.json`](postman/billing-local.postman_environment.json). Bảng biến và cách chạy xem [`huong-dan-postman.md`](huong-dan-postman.md).

| Biến | Cần điền? | Nguồn giá trị |
| --- | --- | --- |
| `webhook_secret` | **Có**, trước khi chạy các request webhook ký tay | `deploy/.env`, biến `LOCAL_WEBHOOK_SECRET` |
| Các biến còn lại | Không, đã có giá trị mặc định | Khớp với `LOCAL_WALLET_PORT`, `LOCAL_PAYMENT_PORT`, `LOCAL_TENANTS` |

Không ghi giá trị secret vào tài liệu hay commit lên git ngoài file environment.

## 5. Lưu ý khi chạy nhiều test liền nhau

- Đối soát đọc sao kê payment của **cả ngày UTC hiện tại**. Charge tạo trực tiếp ở payment kèm `metadata.tenantId` mà không có topup tương ứng sẽ sinh ca lệch. Chạy test đối soát "lượt sạch" **trước** các test tạo lệch.
- Charge tạo trực tiếp ở payment **không có** `metadata.tenantId` làm webhook về wallet bị từ chối (400); payment gửi lại theo backoff `1,5,30,120,600` giây rồi chuyển `FAILED` (khoảng 12 phút). Số dư không đổi nhưng log và metric webhook bị nhiễu.
- Chạy gần nửa đêm UTC có thể làm các test sao kê theo ngày bị lệch.
