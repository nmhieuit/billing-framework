# Manual test plan: Retention (dọn dữ liệu) và quan sát

> **Giai đoạn 2, nhóm F.** Mỗi service (wallet, payment) có job nền xóa định kỳ dữ liệu đã hết giá trị (outbox đã gửi, inbox khử trùng, khóa idempotency, lịch sử đối soát đã đóng, webhook đã giao). Job **bật sẵn nhưng chạy thử** (`RETENTION_DRY_RUN=true`) cho tới khi người vận hành đặt `false` (`docs/ops/retention.vi.md`; ADR-0012; `README.md` mục Dọn dữ liệu).
> Môi trường: **local stack**; quan sát bằng **log và Kibana** (đã xác nhận). **Được phép xóa thật, không hoàn tác** trên local (đã xác nhận). Chỉ dùng dữ liệu thử.
> Mọi "kết quả mong đợi" **đọc từ code và `retention.vi.md`, chưa chạy thật**. Chỗ chưa chắc ghi **[Chưa xác minh]**.

## 1. Điều cần biết trước khi test (ảnh hưởng thiết kế test)

**Dữ liệu mới không bao giờ đủ cũ để bị xóa.** Mỗi chính sách chỉ xóa dòng cũ hơn `cutoff = bắt đầu lượt - số ngày`, và số ngày **tối thiểu** là:

| Chính sách | Mặc định | Tối thiểu | Biến |
| --- | --- | --- | --- |
| wallet `outbox_sent` | 14 | **1** | `RETENTION_OUTBOX_SENT_DAYS` |
| wallet `processed_messages` | 30 | 7 | `RETENTION_PROCESSED_MESSAGES_DAYS` |
| wallet/payment `idempotency_keys` | 90 | 7 | `RETENTION_IDEMPOTENCY_KEYS_DAYS` |
| wallet `reconciliation_items`/`reconciliation_runs` | 365 | 30 | `RETENTION_RECONCILIATION_DAYS` |
| payment `webhook_attempts`/`webhook_events` | 30 | **1** | `RETENTION_WEBHOOK_DAYS` |

(`docs/ops/retention.vi.md`, mục Chính sách và Tham chiếu cấu hình.) Bài viết local-stack cũng xác nhận: "dữ liệu mới dựng/seed trên stack này trẻ hơn mọi ngưỡng (nhỏ nhất 1 ngày) nên thường không có dòng nào" (`docs/ops/local-stack.vi.md`, mục Dọn dữ liệu). Do đó có **ba cách** để có dòng bị dọn:

| Cách | Mô tả | Cần | Trạng thái |
| --- | --- | --- | --- |
| **A. Chờ ≥ 1 ngày** | Đặt `RETENTION_OUTBOX_SENT_DAYS=1` và `RETENTION_WEBHOOK_DAYS=1`, tạo dữ liệu, để stack chạy qua 24 giờ | Chỉ log và Kibana | Chỉ phủ `outbox_sent`, `webhook_*` |
| **B. Lùi mốc thời gian của dòng bằng SQL** (`UPDATE ... SET created_at/sent_at/... = DATEADD(...)`) trên DB local | Phủ mọi chính sách ngay lập tức | **Truy cập SQL Server ghi** (khác lựa chọn log/Kibana của bạn) | **Cần bạn xác nhận** |
| **C. Không có dòng đủ cũ** | Chỉ kiểm cấu hình, chạy thử và "xóa thật nhưng không có gì để xóa" (dữ liệu tài chính nguyên vẹn) | Không | Làm được ngay |

Các case đánh dấu **(cần B)** hoặc **(cần A)** chỉ chạy được khi bạn chọn tương ứng; còn lại chạy theo cách C.

## 2. Chuẩn bị

- Lệnh xem log: `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment | grep -E "retention (run finished|policy failed|run failed)"` (`retention.vi.md`, "Một lượt chạy diễn ra thế nào"; `local-stack.vi.md`).
- Log `retention run finished` chỉ ghi **khi có dòng được xóa/đếm hoặc có lỗi**; kèm `dryRun`, `errors`, `rows`, `policies`, `byTable` (danh sách tenant/table/count) (`retention.vi.md`).
- Lượt đầu chạy **ngay khi service khởi động**, các lượt sau cách nhau `RETENTION_INTERVAL_MINUTES` (mặc định 60) tính từ lúc lượt trước kết thúc.
- Metric (Kibana → dashboard "Billing: vận hành"): `billing.retention.rows` (counter, nhãn `table`, `mode` = `deleted`/`would_delete`, `tenant` chỉ ở wallet) và `billing.retention.last_success_timestamp_seconds` (gauge). Panel: "Retention: số dòng đã xoá / sẽ xoá (tích luỹ)", "Retention: số giây từ lần chạy thành công gần nhất" (`retention.vi.md`, `kibana-alerts-and-dashboard.vi.md:193`).
- **Cách đổi cấu hình trên local** (đã được tài liệu mô tả): sửa `deploy/compose.services.yml` (mục `environment` của `wallet`/`payment`; hiện có `RETENTION_DRY_RUN: 'true'` ở dòng 70 và 95) rồi `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d wallet payment`; **trả lại giá trị gốc trước khi commit** (`local-stack.vi.md`, mục Dọn dữ liệu). Cách thay thế không sửa file được theo dõi: file override tạm không commit **[Chưa xác minh]** (`-f` thêm file compose cùng tên service).
- **Truy vấn SQL (chỉ cho cách B và đếm dòng)**: `docker compose -f deploy/compose.local.yml --env-file deploy/.env exec sqlserver /opt/mssql-tools18/bin/sqlcmd -S localhost -U sa -P "<mật khẩu sa>" -C -Q "<câu SQL>"` (mẫu từ `deploy/compose.infra.yml:27`). Tên bảng wallet: `t_<tenant>.outbox`, `.processed_messages`, `.idempotency_keys`, `.reconciliation_items`, `.reconciliation_runs`, `.topups`, `.ledger_entries`, `.accounts`, `.ops_actions`, `.order_payments`; payment: `charges`, `webhook_events`, `webhook_attempts`, `idempotency_keys` (`retention.repository.ts` của hai service; `retention.vi.md`). **[Chưa xác minh]** tên cột chính xác ngoài những cột xuất hiện trong điều kiện xóa (`status`, `sent_at`, `processed_at`, `created_at`, `delivered_at`, `finished_at`, `case_status`, `resolved_at`).
- **Luôn đếm trước/sau** các bảng tài chính (case RET-022): `ledger_entries`, `ledger_transactions`, `accounts`, `topups`, `order_payments` (wallet), `charges` (payment).

## 3. Phân loại: manual hay tự động hóa

| Phần | Manual (nên) | Tự động hóa sau | Lý do |
| --- | --- | --- | --- |
| Kiểm tra cấu hình khi khởi động (sai thì từ chối chạy) | Một lượt đầu | Test đã có (`services/*/src/config.test.ts`, `env-example.test.ts`) | Rẻ |
| Xóa thật đúng dòng, giữ dòng chưa xong, không chạm dữ liệu tài chính | **Có** (trên local, vì không hoàn tác) | Test integration đã có (`retention.integration.test.ts`, `retention.repository.integration.test.ts`) | Là nơi rủi ro mất dữ liệu cao nhất |
| Hành vi sau khi dọn (khử trùng, cửa sổ idempotency) | **Có** | Một phần có test | Cần hiểu hệ quả nghiệp vụ |
| Lô nhỏ, ngân sách thời gian, `readpast` | Không | Test integration | Cần dữ liệu lớn |
| Metric, dashboard, cảnh báo | **Có** | `kibana:verify` | Cần nhìn thực tế |

## 4. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 4.1 Cấu hình và khởi động

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RET-001 | **Mặc định: bật và chạy thử** | Stack mới dựng | Xem `deploy/compose.services.yml` và log khởi động | `RETENTION_DRY_RUN: 'true'` cho cả wallet và payment; job bật (`RETENTION_ENABLED` mặc định `true`); không có dòng nào bị xóa | P1 | S | `deploy/compose.services.yml:70,95`; `retention.vi.md` |
| RET-002 | Gauge xuất hiện sau lượt đầu | Stack vừa khởi động | Kibana: panel "Retention: số giây từ lần chạy thành công gần nhất" | Có điểm dữ liệu cho `wallet` và `payment`, kể cả khi chưa dòng nào đủ điều kiện; tuổi tăng dần giữa các lượt | P1 | S | `local-stack.vi.md` (mục Dọn dữ liệu); `retention.vi.md` |
| RET-003 | Cấu hình sai khiến service từ chối chạy | Được phép sửa env tạm | Đặt `RETENTION_IDEMPOTENCY_KEYS_DAYS: '3'` (dưới mức tối thiểu 7); `docker compose ... up -d wallet`; xem log | Service **không khởi động**, log `ConfigError` liệt kê lỗi; (trả lại giá trị gốc sau test) | P1 | R | `retention.vi.md` ("Cấu hình được kiểm tra khi khởi động") |
| RET-004 | Giá trị ngoài khoảng/sai kiểu | Như trên | Lần lượt: `RETENTION_BATCH_SIZE: '4001'`; `RETENTION_OUTBOX_SENT_DAYS: '0'`; `RETENTION_DRY_RUN: 'yes'`; `RETENTION_*_DAYS: '3651'`; `RETENTION_INTERVAL_MINUTES: '1441'` | Mỗi trường hợp: service từ chối khởi động và liệt kê **mọi** lỗi (không chỉ lỗi đầu) | P2 | R | `retention.vi.md` (bảng "Tham chiếu cấu hình": khoảng hợp lệ; boolean chỉ `true`/`false`) |
| RET-005 | Tắt job | Được phép sửa env tạm | `RETENTION_ENABLED: 'false'`, khởi động lại wallet | Không có log retention, **không có gauge mới**; rule `billing-retention-stalled` **không nổ** (rule chỉ theo dõi service từng báo thành công trong `lookbackHours`) | P2 | R | `retention.vi.md` mục `billing-retention-stalled` |
| RET-006 | Số ngày tối thiểu hợp lệ | Như trên | Đặt `RETENTION_OUTBOX_SENT_DAYS: '1'`, `RETENTION_WEBHOOK_DAYS: '1'` (mức tối thiểu) | Service khởi động bình thường, lượt đầu chạy | P3 | R | `retention.vi.md` |

### 4.2 Chạy thử (dry-run)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RET-010 | Chạy thử không xóa gì | **(cần B)** có dòng đủ cũ (ví dụ lùi `sent_at` của vài dòng `outbox` `SENT` sang 30 ngày trước); `RETENTION_DRY_RUN=true`; đếm trước | Đợi một lượt (hoặc khởi động lại wallet để lượt chạy ngay) | Log `retention run finished` có `dryRun:true` và `byTable` liệt kê đúng số dòng đủ điều kiện; **số dòng trong bảng không đổi**; counter `mode=would_delete` tăng | P1 | S | `retention.vi.md` ("Từ chạy thử sang xóa thật") |
| RET-011 | Counter `would_delete` cộng dồn qua các lượt | **(cần B)**, đặt `RETENTION_INTERVAL_MINUTES: '1'` | Để chạy 3 lượt liên tiếp | Counter tăng **mỗi lượt** thêm đúng số dòng đủ điều kiện (đếm lại cùng các dòng), nên tổng lớn hơn nhiều lần ước lượng một lượt; số một lượt lấy từ `byTable` | P2 | R | `retention.vi.md` ("Counter `would_delete` là tổng dồn") |
| RET-012 | Không có dòng đủ cũ: log không xuất hiện | Cách C | Xem log sau lượt chạy | **Không** có `retention run finished` (chỉ ghi khi có dòng hoặc lỗi); gauge vẫn được làm mới | P2 | R | `retention.vi.md`; `local-stack.vi.md` |
| RET-013 | Số đếm thử của bảng phụ thuộc thấp hơn thực tế | **(cần B)** | Lùi mốc cho item đối soát đã đóng và lượt đối soát (hoặc `webhook_events` có `webhook_attempts`) | `reconciliation_runs`/`webhook_events` **đếm thiếu** (lượt còn item/sự kiện còn lần thử chưa đủ điều kiện): đúng mô tả giới hạn chế độ thử | P3 | R | `retention.vi.md` mục "Đọc số đếm" |

### 4.3 Xóa thật

Chuyển sang xóa thật: đặt `RETENTION_DRY_RUN: 'false'` trong `deploy/compose.services.yml` cho một service, `up -d` service đó, xem log (`mode = deleted`, `errors`); làm **lần lượt từng service** (`retention.vi.md`, bước 5). **Không hoàn tác.**

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RET-020 | **Xóa thật nhưng không có dòng đủ cũ** | Cách C; đã có dữ liệu từ nhóm A/B/C; đếm mọi bảng trước | `RETENTION_DRY_RUN: 'false'` cho wallet, `up -d wallet`; chờ ≥ 1 lượt; rồi tương tự payment | Không có dòng nào bị xóa; số dòng mọi bảng **không đổi**; API vẫn trả đúng (số dư, entries, topups, ví) | P1 | S | `retention.vi.md` ("Luật an toàn"); `retention.repository.ts` |
| RET-021 | **Xóa đúng dòng đủ cũ, giữ dòng trẻ** | **(cần B)** Hai nhóm dòng trong cùng bảng: cũ (lùi 30 ngày) và mới; `RETENTION_DRY_RUN=false`, `RETENTION_OUTBOX_SENT_DAYS=14` | Chờ lượt chạy; đếm lại | Chỉ dòng `outbox` `SENT` có `sent_at < now-14d` bị xóa; dòng trẻ và dòng `PENDING` còn nguyên; log `mode:"deleted"` với số khớp; counter `mode=deleted` tăng | P1 | S | `retention.repository.ts` (outbox_sent: `status='SENT' and sent_at < cutoff`) |
| RET-022 | **Không chạm dữ liệu tài chính** | **(cần B)** hoặc cách C; đếm `ledger_entries`, `ledger_transactions`, `accounts`, `topups`, `order_payments`, `charges` | Xóa thật mọi chính sách (cả hai service) với dữ liệu đủ cũ ở **mọi** bảng retention | Số dòng của các bảng tài chính **không đổi**; số dư ví không đổi | P1 | R | `retention.vi.md` mục "Luật an toàn" 1 |
| RET-023 | `ops_actions` không bao giờ bị xóa | **(cần B)** nếu muốn lùi `created_at` (bảng chỉ thêm, trigger chặn UPDATE/DELETE nên **không lùi được**) | Với cách C: đếm `t_acme.ops_actions` trước/sau xóa thật | Số dòng `ops_actions` không đổi | P1 | R | `retention.vi.md` ("`ops_actions` ... không bao giờ bị retention xóa") |
| RET-024 | Dòng chưa xong luôn được giữ | **(cần B)** | Lùi mốc các dòng: item đối soát `OPEN`; lượt `RUNNING`; outbox `PENDING`; webhook `PENDING` và `FAILED`; xóa thật | Tất cả các dòng trên còn nguyên; chỉ item đã `RESOLVED`/`IGNORED`, outbox `SENT`, webhook `DELIVERED` bị xóa | P1 | R | `retention.vi.md` ("Dòng chưa xong luôn được giữ") |
| RET-025 | Thứ tự khóa ngoại: item trước run; attempts trước event | **(cần B)** lượt đối soát đã xong có item đã đóng, và webhook `DELIVERED` có attempts, đều đủ cũ | Xóa thật, theo dõi qua 2 lượt | Lượt đầu xóa item (và attempts) rồi mới xóa run (và event) khi hết bảng con; không lỗi khóa ngoại; log `errors:0` | P2 | R | `retention.vi.md` ("Thứ tự chính sách là thứ tự khóa ngoại") |
| RET-026 | Cô lập lỗi từng chính sách | Khó tạo ở local **[Chưa xác minh]** | Bỏ qua; đã có test integration | — | P3 | R | `retention.vi.md` ("Lỗi được cô lập") |
| RET-027 | Quay lại chạy thử | Sau RET-020 | Đặt `RETENTION_DRY_RUN: 'true'`, `up -d` lại | Lượt sau chỉ đếm; không xóa | P2 | R | `retention.vi.md` |

### 4.4 Hệ quả nghiệp vụ sau khi dọn

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RET-030 | **Khử trùng vẫn an toàn sau khi xóa `processed_messages`** | **(cần B)** Một order đã trả (ORD-001, nhóm C); lùi `processed_at` của dòng inbox tương ứng sang 30 ngày trước; xóa thật | Publish lại **nguyên văn** message ORD-001 (cùng `eventId`) | Không trừ thêm tiền: kết quả `REPLAYED` (vì `order_payments` còn), số dư không đổi, phát lại `OrderPaidV1` cùng `walletTransactionId` | P1 | R | `retention.vi.md` ("Khử trùng vẫn đúng sau khi dọn"); `pay-order.ts:87-117` |
| RET-031 | **Hết cửa sổ idempotency: khóa cũ được coi là yêu cầu mới** | **(cần B)** Một topup có `Idempotency-Key` `qa-ret-031`; lùi `created_at` của dòng `idempotency_keys` wallet sang ≥ 90 ngày; xóa thật | `POST /topups` với **cùng khóa và cùng nội dung** | `202` với **`topupId` mới** (một topup thứ hai), khác `IDM-003` (trong cửa sổ trả lại topup cũ). Số dư sau khi xong tăng thêm **lần nữa**: đây là hành vi đã tài liệu hóa, cần Orders/client biết | P1 | R | `retention.vi.md` ("Ý nghĩa của cửa sổ idempotency"); `request-topup.ts` |
| RET-032 | Đối chiếu RET-031 trong cửa sổ | Dòng khóa còn trẻ | Cùng khóa, cùng nội dung | `202` cùng `topupId` cũ (IDM-003) | P1 | R | `request-topup.ts` (`replay`) |
| RET-033 | Idempotency của payment sau khi dọn | **(cần B)** | Như RET-031 với `POST /charges` và `idempotency_keys` của payment | `202` với `chargeId` mới | P2 | R | `retention.vi.md`; `create-charge.ts` |
| RET-034 | Webhook đã giao bị dọn không ảnh hưởng sao kê | **(cần B)** Charge đã `DELIVERED`; lùi `delivered_at` sang 30+ ngày | Xóa thật; gọi `GET /settlements?date=<hôm nay>` | Charge vẫn có trong sao kê (`charges` không bị dọn); chỉ `webhook_events`/`webhook_attempts` mất | P1 | R | `retention.vi.md` (luật an toàn 1); `get-settlement.ts` |
| RET-035 | Đối soát hôm sau không bị ảnh hưởng | **(cần B)** | Sau khi xóa thật, chạy `POST /reconciliations` cho hôm nay | Lượt chạy bình thường, không lỗi do thiếu dữ liệu đã dọn | P2 | R | `reconciliation-runbook.vi.md` mục Lưu ý vận hành |

### 4.5 Quan sát: metric, dashboard, cảnh báo

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RET-040 | Panel số dòng theo `table/mode` | Sau RET-010 và RET-021 | Kibana dashboard "Billing: vận hành" → panel "Retention: số dòng đã xoá / sẽ xoá (tích luỹ)" | Series `would_delete` và `deleted` theo bảng; tụt về 0 khi service khởi động lại là bình thường (counter tích lũy theo tiến trình) | P2 | R | `retention.vi.md` mục metric; `kibana-alerts-and-dashboard.vi.md:193` |
| RET-041 | Panel tuổi lượt thành công gần nhất | Stack chạy | Panel "Retention: số giây từ lần chạy thành công gần nhất" | Tuổi tăng dần rồi về gần 0 sau mỗi lượt; có đường ngưỡng `maxAgeHours * 3600` s (mặc định 10800 s) | P2 | R | `retention.vi.md` |
| RET-042 | Rule `billing-retention-stalled` im lặng khi khỏe | Stack khỏe | Kibana → Rules (tag `billing`) | Không báo (chỉ nổ khi lượt thành công gần nhất cũ hơn `maxAgeHours`, mặc định 3 giờ) | P1 | S | `retention.vi.md`; `kibana-alerts-and-dashboard.vi.md:44,72,90` |
| RET-043 | Rule nổ khi retention liên tục lỗi | Khó tạo **[Chưa xác minh]** (cần làm mọi lượt lỗi, ví dụ thu quyền DB, rồi chờ > 3 giờ) | Đề xuất **bỏ khỏi manual**, hoặc làm khi có dịp | Rule `billing-retention-stalled` (mức `high`) nổ; log `retention policy failed; continuing` | P3 | R | `retention.vi.md` ("Khi rule nổ") |
| RET-044 | `kibana:verify` xác nhận rule/dashboard | Stack lên, Kibana khỏe | `corepack pnpm kibana:verify` | Thoát mã 0 (rule, dashboard và mọi câu ES\|QL đều PASS) | P2 | S | `README.md`; `local-stack.vi.md` |
| RET-045 | Lượt có lỗi không làm mới gauge | Khó tạo ở local | Bỏ qua; đã mô tả trong tài liệu và có test | — | P3 | R | `retention.vi.md` |

## 5. Bộ Smoke đề xuất

`RET-001`, `RET-002`, `RET-012`, `RET-020`, `RET-042`, `RET-044`; thêm `RET-010` và `RET-021` nếu bạn chọn cách B.

## 6. Kết quả thực thi (điền khi chạy)

| ID | Ngày | Người test | Kết quả (Pass/Fail/Blocked) | Giá trị thực tế khi khác mong đợi | Defect |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 7. Câu hỏi còn mở (riêng nhóm này)

**Đã xác nhận:** chọn **cách A** (chờ ≥ 1 ngày với `RETENTION_OUTBOX_SENT_DAYS=1` và `RETENTION_WEBHOOK_DAYS=1`). Các case "cần B" bị chặn (không có SQL ghi); các case chạy được: RET-001..006, RET-012, RET-020, RET-027, RET-040..042, RET-044, và các case xóa thật của `outbox_sent`/`webhook_*` sau khi dữ liệu đủ 1 ngày.

1. ~~Chọn cách lấy dữ liệu đủ cũ~~ (đã chọn A).
2. **Cách đổi cấu hình**: sửa tạm `deploy/compose.services.yml` rồi trả lại (theo tài liệu), hay dùng file compose override không commit (chưa xác minh chạy được)?
3. **RET-031/033** chứng minh hành vi "tạo topup/charge thứ hai khi hết cửa sổ khóa". Hành vi này đã tài liệu hóa là chủ đích; bạn có muốn đánh dấu là **rủi ro nghiệp vụ** cần bàn với team không?
4. **Tên cột** của các bảng retention chưa đọc hết migration; xác nhận khi chạy cách B.
5. **RET-043** và các case cần làm retention lỗi: bỏ khỏi manual?
