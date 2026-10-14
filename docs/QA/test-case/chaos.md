# Test case: Chaos (lỗi hạ tầng giữa tải)

Mục tiêu: kiểm tra hệ thống vẫn giữ đúng tiền khi hạ tầng hoặc service gặp sự cố giữa lúc đang có tải (service tạm đóng băng, khởi động lại, bị kill, mất kết nối RabbitMQ, mất session SQL). QA tạo tải bằng folder `Chaos` của Postman và tiêm lỗi bằng tay (`docker compose`, RabbitMQ management, `X-Simulate`), sau đó chạy "oracle" để kiểm các bất biến về tiền. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md). Chỉ làm trên local stack với dữ liệu thử.

## 1. Các bất biến cần giữ

| Mã | Bất biến |
| --- | --- |
| INV-1 | Số dư ví bằng tổng các dòng sổ cái; mỗi `businessKey` chỉ có một dòng |
| INV-3 | Mỗi topup `SUCCEEDED` có đúng một dòng sổ cái `TOPUP` và một charge `SUCCEEDED` khớp |
| INV-5 | Chạy đối soát hai lần cho kết quả hội tụ |
| INV-6 | Thao tác ops (adjust/reverse) nguyên tử; gửi lại cùng khóa trả đúng kết quả cũ |
| INV-7 | Mọi `topupId` đã được xác nhận (nhận `202`) vẫn đọc được |
| INV-8 | Sau khi gỡ lỗi, hệ thống hồi phục: không còn topup kẹt ở trạng thái chờ |

Folder `Chaos` kiểm các bất biến này qua API. Không kiểm được INV-2 và INV-4 (cần đọc DB/outbox trực tiếp).

## 2. Folder `Chaos` trong Postman

Sinh tải hợp lệ (topup, ops adjust/reverse) với `Idempotency-Key` cố định và **gửi lại cùng khóa** khi gặp lỗi tạm (5xx hoặc mất phản hồi), đúng cách client thật xử lý. Việc tiêm lỗi do QA làm bằng tay trong lúc `Workload` chạy.

Collection `Billing` đã gộp mọi thứ; `Chaos` là folder riêng. Chạy bằng Collection Runner hoặc Newman, **đúng thứ tự** (request poll dùng `setNextRequest`). Trạng thái giữa các folder lưu trong biến **environment** `ch_*`, nên phải dùng chung một environment; với Newman dùng `--export-environment`. Xem cách chạy chi tiết ở [`huong-dan-postman.md`](../huong-dan-postman.md).

Quy trình đề xuất:

1. `Smoke` ×1: hệ thống khỏe, có ví và topup nền.
2. `Workload` ×N (ví dụ 25-50 lượt): trong lúc chạy, tiêm lỗi bằng tay theo từng case CHM bên dưới.
3. Gỡ lỗi, chờ hệ thống hồi phục.
4. `Oracle` ×1: ORC-00 chờ ổn định tối đa `chaos_quiesce_seconds`, rồi ORC-01..06.
5. `Regression` bất kỳ lúc nào hệ thống khỏe.

### Biến

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `chaos_quiesce_seconds` | `120` | Thời gian tối đa ORC-00 chờ mọi topup đã xác nhận rời trạng thái chờ. Tăng nếu lỗi gỡ chậm |
| `chaos_expect_missing_at_wallet` | `false` | `true` nếu cố ý để tồn dư lệch (`MISSING_AT_WALLET`) trước đối soát |
| `chaos_allow_unknown_charge` | `true` | Cho phép charge không có topup (webhook rơi khi wallet chưa có bản ghi) trước đối soát; ORC-06 kiểm lại nghiêm ngặt sau đối soát |
| `webhook_secret` | điền từ `deploy/.env` | Chỉ cần cho CHR-04 |
| `ch_*` | do script tạo | Trạng thái chạy: `ch_custs`, `ch_topups`, `ch_ops`, `ch_adj_open`, `ch_pending_topup`, `ch_pending_op`, `ch_stats`, `ch_bad`, `ch_run`. **Không sửa tay**; xóa hết để bắt đầu lại |

### Nội dung từng folder

| Folder | Request | Mục đích / bất biến |
| --- | --- | --- |
| Smoke | CHS-01..09 | Health, 4 ví (2 tenant), topup nền tới SUCCEEDED, kiểm nhanh trên hệ thống khỏe |
| Workload | WLD-01 | Topup, gửi lại cùng khóa tới khi nhận 202; chỉ topup đã xác nhận mới vào danh sách kiểm sau |
| | WLD-02 | Ops adjust/reverse, gửi lại cùng khóa tới khi xác nhận |
| | WLD-03, 04 | Đọc ví; tóm tắt (kiểm "có tải thật" chỉ ở lượt cuối) |
| Oracle | ORC-00 | Chờ ổn định (INV-8) |
| | ORC-01 | INV-8 hồi phục, INV-1 số dư = tổng dòng sổ, mỗi businessKey một dòng |
| | ORC-02 | INV-3 mỗi topup SUCCEEDED có đúng 1 dòng TOPUP và 1 charge SUCCEEDED khớp |
| | ORC-03 | INV-6 ops nguyên tử; gửi lại cùng khóa trả đúng kết quả cũ |
| | ORC-04 | INV-7 mọi topupId đã xác nhận vẫn đọc được |
| | ORC-05 | INV-5 chạy đối soát hai lần, kết quả hội tụ |
| | ORC-06 | Kiểm lại INV-1/3/8 nghiêm ngặt sau đối soát |
| Regression | CHR-01 | Gửi lại topup cùng khóa ×3: một topup, một lần cộng |
| | CHR-02, 03 | Gửi lại adjust / reverse cùng khóa ×3: một tác động |
| | CHR-04 | Webhook trùng / đến muộn không cộng hai lần (cần `webhook_secret`) |
| | CHR-05 | Đối soát hai lần trên hệ thống sạch hội tụ |

Khi Oracle đỏ, mỗi vi phạm có `code` và `detail` (ví dụ `DUPLICATE_BUSINESS_KEY`, `TOPUP_TX_MISSING`, `IDEMPOTENT_REPLAY_MISMATCH`). Một lần đỏ **không tự là bug**: kiểm tra trước xem lỗi đã được gỡ và hệ thống đã ổn định chưa (tăng `chaos_quiesce_seconds`).

## 3. Quy trình chung cho một lượt chaos

1. **Stack khỏe và sạch lỗi:** `GET /health` hai service, các job `*-init`, `migrate` thoát mã 0.
2. **Postman `Chaos > Smoke`** (chạy 1 lượt): dựng 4 ví ở 2 tenant, một topup nền, kiểm nhanh sạch (CHM-001, CHM-002).
3. **Postman `Chaos > Workload`** với số lượt lặp đủ lớn (ví dụ 30-60), **trong lúc đó** tiêm lỗi bằng lệnh của từng case.
4. **Gỡ lỗi** (`unpause`, `start`...) và chờ hệ yên.
5. **Postman `Chaos > Oracle`** (ORC-00..06).
6. Ghi kết quả; nếu có vi phạm, **lưu log** `docker compose ... logs wallet payment` và đầu ra của Postman.

Tên service dùng trong lệnh `docker compose`: `wallet`, `payment`, `rabbitmq`, `sqlserver` (kiểm lại trong `deploy/compose.local.yml`).

## 4. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất.

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| CHM-001 | Preflight trước chaos | Stack lên | Chạy Postman `Chaos > Smoke` (CHS-01..08) | Hai service `ok`; 4 ví tạo `201`; topup nền `SUCCEEDED` | P1 | S |
| CHM-002 | Oracle sạch trên hệ khỏe | Sau CHM-001 | Chạy `CHS-09` | Không vi phạm INV-1, INV-3, INV-8 | P1 | S |
| CHM-003 | An toàn khi gửi lại/trùng/muộn (không tiêm lỗi) | Sau CHM-001; `webhook_secret` đã đặt | Chạy `Chaos > Regression` (CHR-01..05) | Gửi lại cùng khóa ×3 cho cùng kết quả và **một** hiệu ứng; webhook trùng/muộn không ghi có lần hai; đối soát hai lần hội tụ | P1 | R |
| CHM-010 | Payment tạm đóng băng giữa tải | Sau CHM-001 | (1) Bắt đầu `Workload` ≥ 30 lượt; (2) `docker compose -f deploy/compose.local.yml --env-file deploy/.env pause payment` khoảng 15 s rồi `unpause`; (3) chờ hết Workload; (4) chạy `Oracle` | Workload không có 4xx bất ngờ (chỉ 5xx/chậm tạm thời, gửi lại cùng khóa); Oracle sạch; mỗi topup đã xác nhận chỉ cộng **một lần** | P1 | R |
| CHM-011 | Wallet tạm đóng băng giữa tải (webhook đến chậm) | Sau CHM-001 | Như CHM-010 nhưng `pause wallet` 15-20 s | Webhook payment gửi lại theo backoff, topup về `SUCCEEDED`; Oracle sạch (cần chờ ≤ vài phút do backoff `1,5,30,...`) | P1 | R |
| CHM-012 | Khởi động lại êm (graceful) giữa tải | Sau CHM-001 | `Workload`; `docker compose ... restart wallet` rồi `restart payment` (lần lượt) | Sau khi lên lại, Oracle sạch; không `5xx` kéo dài | P2 | R |
| CHM-013 | `SIGKILL` wallet giữa lúc gửi sang payment | Sau CHM-001 | (1) `POST /topups` (Postman `WLD-01` hoặc `curl`); (2) **ngay lập tức** `docker compose ... kill wallet`; (3) `start wallet`; (4) chờ tới ≈ 60-90 s (lease 60 s) | Topup về `SUCCEEDED`; payment vẫn **một** charge cho `reference` đó; ví cộng **một** lần; Oracle sạch | P1 | R |
| CHM-014 | `SIGKILL` payment trước khi giao webhook | Nên đặt `PAYMENT_WORKER_INTERVAL_MS=20000` trong `deploy/.env` (mục 5) để có cửa sổ | (1) Tạo topup; (2) khi topup `PENDING`, `kill payment` trước tick hoàn tất; (3) `start payment`; (4) chờ | Webhook được giao sau khi payment dựng lại (số lần thử tăng); ví cộng **một** lần; Oracle sạch | P2 | R |
| CHM-015 | Webhook hết lượt: topup treo `PENDING`, đối soát sửa | Sau CHM-001; đặt `chaos_expect_missing_at_wallet=true` | (1) tạo một topup (Postman `WLD-01`); (2) khi topup chuyển `PENDING` (đã gửi sang payment) thì `stop wallet` **ngay** (nên tăng `PAYMENT_WORKER_INTERVAL_MS` như CHM-014); (3) giữ wallet dừng > 756 s (tổng backoff webhook `1,5,30,120,600`); (4) `start wallet`; (5) chạy `ORC-00..ORC-02`, rồi `ORC-05`, `ORC-06` | Trước đối soát: topup `PENDING` nhưng charge `SUCCEEDED` (chỉ `MISSING_AT_WALLET`); `ORC-05` ghi bù đúng một lần (`AUTO_APPLIED`); `ORC-06` sạch; ví cộng **một** lần | P1 | R |
| CHM-016 | Cắt kết nối AMQP của wallet khi xử lý order | Sau CHM-001; queue nhận kết quả đã tạo ([`order-payment.md`](order-payment.md), mục 2) | (1) Publish 10 order (xem [`order-payment.md`](order-payment.md)); (2) RabbitMQ management → Connections → đóng kết nối của `billing_wallet` **hai lần** trong lúc xử lý | Cả 10 order trả **đúng một lần**; không có message mất; không vào DLQ (có thể có giao lại) | P1 | R |
| CHM-018 | KILL mọi session SQL khi hệ rảnh (cần quyền SQL) | Có `sqlcmd`/SQL ghi (đã được cấp quyền) | KILL các session của `billing_wallet` và `billing_payment`; ngay sau đó `GET /wallet` và `POST /topups` | Request kế tiếp **thành công ngay lần đầu** (pool thay session chết thầm lặng) | P3 | R |
| CHM-019 | Tải dài + lỗi ngẫu nhiên bằng tay | Sau CHM-001 | `Workload` ≥ 200 lượt; xen kẽ `pause/unpause` và `restart` ngẫu nhiên hai service | Oracle sạch sau khi hết lỗi; thống kê tải có thao tác thành công (`WLD-04`) | P2 | R |

Các lỗi chính xác tới từng câu lệnh SQL hoặc từng commit (kill session đúng lúc, consumer chết sau commit trước ack) không làm bằng tay được; chúng nằm trong bộ chaos tự động của dev.

## 5. Chỉnh chu kỳ xử lý để có cửa sổ tiêm lỗi

Để có đủ thời gian `kill`/`stop` đúng lúc (CHM-014, CHM-015), đặt trong `deploy/.env`, ví dụ `PAYMENT_WORKER_INTERVAL_MS=20000` (mặc định `500`; tương tự `WALLET_WORKER_INTERVAL_MS`), rồi tạo lại container:

```bash
docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d payment
```

Nhớ bỏ biến sau khi test. Với `20000` ms, tăng `chaos_quiesce_seconds` tương ứng.

## 6. Giới hạn

- Oracle chỉ nhìn qua API; không thấy outbox hay DB.
- Độ trễ thật (backoff `1,5,30,120,600` giây, lease 60 giây) chỉ kiểm được bằng các case tay ở trên.
