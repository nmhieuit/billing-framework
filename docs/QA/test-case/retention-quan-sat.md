# Test case: Retention (dọn dữ liệu) và quan sát

Mỗi service (wallet, payment) có job nền xóa định kỳ dữ liệu đã hết giá trị (outbox đã gửi, inbox khử trùng, khóa idempotency, lịch sử đối soát đã đóng, webhook đã giao). Job **bật sẵn nhưng chạy thử** (`RETENTION_DRY_RUN=true`) cho tới khi người vận hành đặt `false`. Xóa thật **không hoàn tác**: chỉ làm trên local stack với dữ liệu thử. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md).

## 1. Điều cần biết trước khi test

**Dữ liệu mới không bao giờ đủ cũ để bị xóa.** Mỗi chính sách chỉ xóa dòng cũ hơn `cutoff = bắt đầu lượt - số ngày`, và số ngày **tối thiểu** là:

| Chính sách | Mặc định | Tối thiểu | Biến |
| --- | --- | --- | --- |
| wallet `outbox_sent` | 14 | **1** | `RETENTION_OUTBOX_SENT_DAYS` |
| wallet `processed_messages` | 30 | 7 | `RETENTION_PROCESSED_MESSAGES_DAYS` |
| wallet/payment `idempotency_keys` | 90 | 7 | `RETENTION_IDEMPOTENCY_KEYS_DAYS` |
| wallet `reconciliation_items`/`reconciliation_runs` | 365 | 30 | `RETENTION_RECONCILIATION_DAYS` |
| payment `webhook_attempts`/`webhook_events` | 30 | **1** | `RETENTION_WEBHOOK_DAYS` |

Dữ liệu mới dựng hoặc seed trên stack này trẻ hơn mọi ngưỡng (nhỏ nhất 1 ngày) nên thường không có dòng nào. Do đó có **ba cách** để có dòng bị dọn:

| Cách | Mô tả | Cần |
| --- | --- | --- |
| **A. Chờ ≥ 1 ngày** | Đặt `RETENTION_OUTBOX_SENT_DAYS=1` và `RETENTION_WEBHOOK_DAYS=1`, tạo dữ liệu, để stack chạy qua 24 giờ | Chỉ log và Kibana. Chỉ phủ `outbox_sent`, `webhook_*` |
| **B. Lùi mốc thời gian của dòng bằng SQL** (`UPDATE ... SET created_at/sent_at/... = DATEADD(...)`) trên DB local | Phủ mọi chính sách ngay lập tức | **Truy cập SQL Server ghi** |
| **C. Không có dòng đủ cũ** | Chỉ kiểm cấu hình, chạy thử và "xóa thật nhưng không có gì để xóa" (dữ liệu tài chính nguyên vẹn) | Không. Làm được ngay |

Các case đánh dấu **(cần B)** hoặc **(cần A)** chỉ chạy được khi dùng cách tương ứng; các case còn lại chạy theo cách C.

## 2. Chuẩn bị

- Lệnh xem log: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment | grep -E "retention (run finished|policy failed|run failed)"`.
- Log `retention run finished` chỉ ghi **khi có dòng được xóa/đếm hoặc có lỗi**; kèm `dryRun`, `errors`, `rows`, `policies`, `byTable` (danh sách tenant/table/count).
- Lượt đầu chạy **ngay khi service khởi động**, các lượt sau cách nhau `RETENTION_INTERVAL_MINUTES` (mặc định 60) tính từ lúc lượt trước kết thúc.
- Metric (Kibana → dashboard "Billing: vận hành"): `billing.retention.rows` (counter, nhãn `table`, `mode` = `deleted`/`would_delete`, `tenant` chỉ ở wallet) và `billing.retention.last_success_timestamp_seconds` (gauge). Panel: "Retention: số dòng đã xoá / sẽ xoá (tích luỹ)", "Retention: số giây từ lần chạy thành công gần nhất".
- **Cách đổi cấu hình trên local:** sửa `deploy/compose.services.yml` (mục `environment` của `wallet`/`payment`; hiện có `RETENTION_DRY_RUN: 'true'`) rồi `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d wallet payment`; **trả lại giá trị gốc trước khi commit**. Cách khác không sửa file được theo dõi: dùng một file compose override tạm (không commit) khai báo lại `environment` của service qua `-f`.
- **Truy vấn SQL (chỉ cho cách B và đếm dòng)**: `docker compose -f deploy/compose.local.yml --env-file deploy/.env exec sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "<mật khẩu sa>" -C -Q "<câu SQL>"`. Tên bảng wallet: `t_<tenant>.outbox`, `.processed_messages`, `.idempotency_keys`, `.reconciliation_items`, `.reconciliation_runs`, `.topups`, `.ledger_entries`, `.accounts`, `.ops_actions`, `.order_payments`; payment: `charges`, `webhook_events`, `webhook_attempts`, `idempotency_keys`.
- **Luôn đếm trước/sau** các bảng tài chính (case RET-022): `ledger_entries`, `ledger_transactions`, `accounts`, `topups`, `order_payments` (wallet), `charges` (payment).

## 3. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 3.1 Cấu hình và khởi động

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RET-001 | **Mặc định: bật và chạy thử** | Stack mới dựng | Xem `deploy/compose.services.yml` và log khởi động | `RETENTION_DRY_RUN: 'true'` cho cả wallet và payment; job bật (`RETENTION_ENABLED` mặc định `true`); không có dòng nào bị xóa | P1 | S |
| RET-002 | Gauge xuất hiện sau lượt đầu | Stack vừa khởi động | Kibana: panel "Retention: số giây từ lần chạy thành công gần nhất" | Có điểm dữ liệu cho `wallet` và `payment`, kể cả khi chưa dòng nào đủ điều kiện; tuổi tăng dần giữa các lượt | P1 | S |
| RET-003 | Cấu hình sai khiến service từ chối chạy | Được phép sửa env tạm | Đặt `RETENTION_IDEMPOTENCY_KEYS_DAYS: '3'` (dưới mức tối thiểu 7); `docker compose ... up -d wallet`; xem log | Service **không khởi động**, log `ConfigError` liệt kê lỗi; (trả lại giá trị gốc sau test) | P1 | R |
| RET-004 | Giá trị ngoài khoảng/sai kiểu | Như trên | Lần lượt: `RETENTION_BATCH_SIZE: '4001'`; `RETENTION_OUTBOX_SENT_DAYS: '0'`; `RETENTION_DRY_RUN: 'yes'`; `RETENTION_*_DAYS: '3651'`; `RETENTION_INTERVAL_MINUTES: '1441'` | Mỗi trường hợp: service từ chối khởi động và liệt kê **mọi** lỗi (không chỉ lỗi đầu) | P2 | R |
| RET-005 | Tắt job | Được phép sửa env tạm | `RETENTION_ENABLED: 'false'`, khởi động lại wallet | Không có log retention, **không có gauge mới**; rule `billing-retention-stalled` **không nổ** (rule chỉ theo dõi service từng báo thành công trong `lookbackHours`) | P2 | R |
| RET-006 | Số ngày tối thiểu hợp lệ | Như trên | Đặt `RETENTION_OUTBOX_SENT_DAYS: '1'`, `RETENTION_WEBHOOK_DAYS: '1'` (mức tối thiểu) | Service khởi động bình thường, lượt đầu chạy | P3 | R |

### 3.2 Chạy thử (dry-run)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RET-010 | Chạy thử không xóa gì | **(cần B)** có dòng đủ cũ (ví dụ lùi `sent_at` của vài dòng `outbox` `SENT` sang 30 ngày trước); `RETENTION_DRY_RUN=true`; đếm trước | Đợi một lượt (hoặc khởi động lại wallet để lượt chạy ngay) | Log `retention run finished` có `dryRun:true` và `byTable` liệt kê đúng số dòng đủ điều kiện; **số dòng trong bảng không đổi**; counter `mode=would_delete` tăng | P1 | S |
| RET-011 | Counter `would_delete` cộng dồn qua các lượt | **(cần B)**, đặt `RETENTION_INTERVAL_MINUTES: '1'` | Để chạy 3 lượt liên tiếp | Counter tăng **mỗi lượt** thêm đúng số dòng đủ điều kiện (đếm lại cùng các dòng), nên tổng lớn hơn nhiều lần ước lượng một lượt; số một lượt lấy từ `byTable` | P2 | R |
| RET-012 | Không có dòng đủ cũ: log không xuất hiện | Cách C | Xem log sau lượt chạy | **Không** có `retention run finished` (chỉ ghi khi có dòng hoặc lỗi); gauge vẫn được làm mới | P2 | R |
| RET-013 | Số đếm thử của bảng phụ thuộc thấp hơn thực tế | **(cần B)** | Lùi mốc cho item đối soát đã đóng và lượt đối soát (hoặc `webhook_events` có `webhook_attempts`) | `reconciliation_runs`/`webhook_events` **đếm thiếu** (lượt còn item/sự kiện còn lần thử chưa đủ điều kiện): đúng mô tả giới hạn chế độ thử | P3 | R |

### 3.3 Xóa thật

Chuyển sang xóa thật: đặt `RETENTION_DRY_RUN: 'false'` trong `deploy/compose.services.yml` cho một service, `up -d` service đó, xem log (`mode = deleted`, `errors`); làm **lần lượt từng service**. **Không hoàn tác.**

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RET-020 | **Xóa thật nhưng không có dòng đủ cũ** | Cách C; đã có dữ liệu từ các test ở [`wallet.md`](wallet.md), [`payment-simulator.md`](payment-simulator.md), [`order-payment.md`](order-payment.md); đếm mọi bảng trước | `RETENTION_DRY_RUN: 'false'` cho wallet, `up -d wallet`; chờ ≥ 1 lượt; rồi tương tự payment | Không có dòng nào bị xóa; số dòng mọi bảng **không đổi**; API vẫn trả đúng (số dư, entries, topups, ví) | P1 | S |
| RET-021 | **Xóa đúng dòng đủ cũ, giữ dòng trẻ** | **(cần B)** Hai nhóm dòng trong cùng bảng: cũ (lùi 30 ngày) và mới; `RETENTION_DRY_RUN=false`, `RETENTION_OUTBOX_SENT_DAYS=14` | Chờ lượt chạy; đếm lại | Chỉ dòng `outbox` `SENT` có `sent_at < now-14d` bị xóa; dòng trẻ và dòng `PENDING` còn nguyên; log `mode:"deleted"` với số khớp; counter `mode=deleted` tăng | P1 | S |
| RET-022 | **Không chạm dữ liệu tài chính** | **(cần B)** hoặc cách C; đếm `ledger_entries`, `ledger_transactions`, `accounts`, `topups`, `order_payments`, `charges` | Xóa thật mọi chính sách (cả hai service) với dữ liệu đủ cũ ở **mọi** bảng retention | Số dòng của các bảng tài chính **không đổi**; số dư ví không đổi | P1 | R |
| RET-023 | `ops_actions` không bao giờ bị xóa | **(cần B)** nếu muốn lùi `created_at` (bảng chỉ thêm, trigger chặn UPDATE/DELETE nên **không lùi được**) | Với cách C: đếm `t_acme.ops_actions` trước/sau xóa thật | Số dòng `ops_actions` không đổi | P1 | R |
| RET-024 | Dòng chưa xong luôn được giữ | **(cần B)** | Lùi mốc các dòng: item đối soát `OPEN`; lượt `RUNNING`; outbox `PENDING`; webhook `PENDING` và `FAILED`; xóa thật | Tất cả các dòng trên còn nguyên; chỉ item đã `RESOLVED`/`IGNORED`, outbox `SENT`, webhook `DELIVERED` bị xóa | P1 | R |
| RET-025 | Thứ tự khóa ngoại: item trước run; attempts trước event | **(cần B)** lượt đối soát đã xong có item đã đóng, và webhook `DELIVERED` có attempts, đều đủ cũ | Xóa thật, theo dõi qua 2 lượt | Lượt đầu xóa item (và attempts) rồi mới xóa run (và event) khi hết bảng con; không lỗi khóa ngoại; log `errors:0` | P2 | R |
| RET-027 | Quay lại chạy thử | Sau RET-020 | Đặt `RETENTION_DRY_RUN: 'true'`, `up -d` lại | Lượt sau chỉ đếm; không xóa | P2 | R |

### 3.4 Hệ quả nghiệp vụ sau khi dọn

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RET-030 | **Khử trùng vẫn an toàn sau khi xóa `processed_messages`** | **(cần B)** Một order đã trả (ORD-001 ở [`order-payment.md`](order-payment.md)); lùi `processed_at` của dòng inbox tương ứng sang 30 ngày trước; xóa thật | Publish lại **nguyên văn** message ORD-001 (cùng `eventId`) | Không trừ thêm tiền: kết quả `REPLAYED` (vì `order_payments` còn), số dư không đổi, phát lại `OrderPaidV1` cùng `walletTransactionId` | P1 | R |
| RET-031 | **Hết cửa sổ idempotency: khóa cũ được coi là yêu cầu mới** | **(cần B)** Một topup có `Idempotency-Key` `qa-ret-031`; lùi `created_at` của dòng `idempotency_keys` wallet sang ≥ 90 ngày; xóa thật | `POST /topups` với **cùng khóa và cùng nội dung** | `202` với **`topupId` mới** (một topup thứ hai), khác `IDM-003` (trong cửa sổ trả lại topup cũ). Số dư sau khi xong tăng thêm **lần nữa**: đây là hành vi đã tài liệu hóa, cần Orders/client biết | P1 | R |
| RET-032 | Đối chiếu RET-031 trong cửa sổ | Dòng khóa còn trẻ | Cùng khóa, cùng nội dung | `202` cùng `topupId` cũ (IDM-003) | P1 | R |
| RET-033 | Idempotency của payment sau khi dọn | **(cần B)** | Như RET-031 với `POST /charges` và `idempotency_keys` của payment | `202` với `chargeId` mới | P2 | R |
| RET-034 | Webhook đã giao bị dọn không ảnh hưởng sao kê | **(cần B)** Charge đã `DELIVERED`; lùi `delivered_at` sang 30+ ngày | Xóa thật; gọi `GET /settlements?date=<hôm nay>` | Charge vẫn có trong sao kê (`charges` không bị dọn); chỉ `webhook_events`/`webhook_attempts` mất | P1 | R |
| RET-035 | Đối soát hôm sau không bị ảnh hưởng | **(cần B)** | Sau khi xóa thật, chạy `POST /reconciliations` cho hôm nay | Lượt chạy bình thường, không lỗi do thiếu dữ liệu đã dọn | P2 | R |

### 3.5 Quan sát: metric, dashboard, cảnh báo

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RET-040 | Panel số dòng theo `table/mode` | Sau RET-010 và RET-021 | Kibana dashboard "Billing: vận hành" → panel "Retention: số dòng đã xoá / sẽ xoá (tích luỹ)" | Series `would_delete` và `deleted` theo bảng; tụt về 0 khi service khởi động lại là bình thường (counter tích lũy theo tiến trình) | P2 | R |
| RET-041 | Panel tuổi lượt thành công gần nhất | Stack chạy | Panel "Retention: số giây từ lần chạy thành công gần nhất" | Tuổi tăng dần rồi về gần 0 sau mỗi lượt; có đường ngưỡng `maxAgeHours * 3600` s (mặc định 10800 s) | P2 | R |
| RET-042 | Rule `billing-retention-stalled` im lặng khi khỏe | Stack khỏe | Kibana → Rules (tag `billing`) | Không báo (chỉ nổ khi lượt thành công gần nhất cũ hơn `maxAgeHours`, mặc định 3 giờ) | P1 | S |
| RET-044 | `kibana:verify` xác nhận rule/dashboard | Stack lên, Kibana khỏe | `corepack pnpm kibana:verify` | Thoát mã 0 (rule, dashboard và mọi câu ES\|QL đều PASS) | P2 | S |

## 4. Bộ Smoke đề xuất

`RET-001`, `RET-002`, `RET-012`, `RET-020`, `RET-042`, `RET-044`; thêm `RET-010` và `RET-021` nếu dùng cách B.
