# Dọn dữ liệu cũ (retention) của wallet và payment

Tài liệu cho người vận hành: wallet và payment mỗi service có một job nền xóa định kỳ các dòng đã hết giá trị (outbox đã gửi,
inbox khử trùng, khóa idempotency, lịch sử đối soát đã đóng, webhook đã giao) để các bảng này không lớn mãi. Job **bật sẵn nhưng
chạy thử (dry-run)**: chỉ đếm và log cho tới khi bạn tự đặt `RETENTION_DRY_RUN=false`. Thiết kế:
[spec 6b](../superpowers/specs/2026-10-12-retention-design.md); quyết định:
[ADR-0012](../adr/0012-batched-dry-run-first-retention.vi.md); cảnh báo và dashboard:
[kibana-alerts-and-dashboard](kibana-alerts-and-dashboard.vi.md); chạy thử trên máy: [local-stack](local-stack.vi.md).

> **Xóa là không hoàn tác và không có archive.** Chỉ chuyển sang xóa thật sau khi đã theo quy trình ở mục "Từ chạy thử sang xóa
> thật", và trên production phải sao lưu database trước.

## Chính sách

Mỗi dòng của bảng dưới là một **chính sách**; tên chính sách cũng là nhãn `table` của metric. `cutoff = thời điểm bắt đầu lượt -
số ngày`, lấy từ `Clock` của service (không dùng đồng hồ SQL Server), nên mọi chính sách trong cùng một lượt dùng cùng một mốc.

| Service | Chính sách (nhãn `table`) | Dòng bị xóa khi | Mặc định | Tối thiểu | Biến môi trường |
| ------- | ------------------------- | --------------- | -------- | --------- | --------------- |
| wallet  | `reconciliation_items`    | `case_status` là `RESOLVED` hoặc `IGNORED` và `created_at < cutoff` và `coalesce(resolved_at, created_at) < cutoff` | 365 ngày | 30 | `RETENTION_RECONCILIATION_DAYS` |
| wallet  | `reconciliation_runs`     | `status <> 'RUNNING'`, `finished_at < cutoff` và không còn item nào của lượt đó | 365 ngày (dùng chung biến trên) | 30 | `RETENTION_RECONCILIATION_DAYS` |
| wallet  | `outbox_sent`             | `status = 'SENT'` và `sent_at < cutoff` | 14 ngày | 1 | `RETENTION_OUTBOX_SENT_DAYS` |
| wallet  | `processed_messages`      | `processed_at < cutoff` | 30 ngày | 7 | `RETENTION_PROCESSED_MESSAGES_DAYS` |
| wallet  | `idempotency_keys`        | `created_at < cutoff` | 90 ngày | 7 | `RETENTION_IDEMPOTENCY_KEYS_DAYS` |
| payment | `webhook_attempts`        | các lần thử của sự kiện `DELIVERED` có `delivered_at < cutoff` | 30 ngày | 1 | `RETENTION_WEBHOOK_DAYS` |
| payment | `webhook_events`          | `status = 'DELIVERED'`, `delivered_at < cutoff` và không còn lần thử nào của sự kiện | 30 ngày (dùng chung biến trên) | 1 | `RETENTION_WEBHOOK_DAYS` |
| payment | `idempotency_keys`        | `created_at < cutoff` | 90 ngày | 7 | `RETENTION_IDEMPOTENCY_KEYS_DAYS` |

Wallet chạy mọi chính sách cho **từng tenant** (mỗi tenant là một schema); metric của wallet mang thêm nhãn `tenant`.

### Luật an toàn

1. **Không bao giờ chạm vào dữ liệu tài chính**: `ledger_transactions`, `ledger_entries`, `accounts`, `topups`,
   `order_payments` (wallet) và `charges` (payment). Danh sách bảng mà mỗi chính sách đọc/ghi là dữ liệu có kiểm tra bằng test
   (không chứa các bảng này), và test tích hợp chứng minh số dòng của chúng không đổi sau một lượt dọn đầy đủ.
2. **Dòng chưa xong luôn được giữ**: mục đối soát `OPEN`; lượt đối soát `RUNNING` hoặc còn dù chỉ một item; dòng outbox
   `PENDING` (chưa gửi); webhook `PENDING` và `FAILED` (hết lượt thử, giữ để điều tra). Chỉ webhook `DELIVERED` mới bị xóa.
3. **Khử trùng vẫn đúng sau khi dọn.** Xóa `processed_messages` quá hạn chỉ làm một message giao lại rất muộn (sau hơn
   `RETENTION_PROCESSED_MESSAGES_DAYS` ngày) được xử lý lại; việc đó vẫn không trừ tiền hai lần vì `order_payments` (khóa theo
   `orderId`, dùng để phát lại `OrderPaidV1`) và trạng thái `topups` (`SUCCEEDED` chặn cộng trùng) không bao giờ bị xóa.
4. **Ý nghĩa của "cửa sổ idempotency".** Xóa `idempotency_keys` quá hạn nghĩa là cùng một `Idempotency-Key` gửi lại **sau**
   `RETENTION_IDEMPOTENCY_KEYS_DAYS` ngày được coi là một yêu cầu mới. Trong cửa sổ (mặc định 90 ngày) khóa vẫn chặn yêu cầu
   lặp. Client của wallet/payment không được tái dùng một khóa cho nghiệp vụ khác sau khi cửa sổ đã qua, và không nên kỳ vọng
   khử trùng theo khóa lâu hơn cửa sổ này.
5. **Cấu hình được kiểm tra khi khởi động**: mỗi số ngày phải là số nguyên không nhỏ hơn mức tối thiểu ở bảng trên (và không quá
   3650); sai thì service từ chối khởi động và liệt kê mọi lỗi (`ConfigError`).

## Một lượt chạy diễn ra thế nào

- Mỗi service có một `Worker` riêng cho retention (không dùng chung với worker gửi outbox/đối soát). Lượt đầu chạy ngay khi service
  khởi động, các lượt sau cách nhau `RETENTION_INTERVAL_MINUTES` (tính từ lúc lượt trước kết thúc, nên hai lượt không bao giờ
  chồng trong cùng một tiến trình). `RETENTION_ENABLED=false` thì không tạo worker.
- **Ngân sách thời gian** `RETENTION_MAX_SECONDS_PER_RUN` (mặc định 60 giây): được kiểm tra **giữa các lô** và giữa các chính sách,
  không ngắt lô đang chạy. Hết ngân sách là bình thường và vẫn tính là lượt thành công.
- **Lô nhỏ**: mỗi lô là một câu `delete top (N) ... with (readpast, rowlock)` trong một transaction ngắn, `N = RETENTION_BATCH_SIZE`
  (tối đa 4000, để dưới ngưỡng nâng cấp khóa của SQL Server). `readpast` bỏ qua dòng đang bị khóa bởi transaction khác thay vì
  chờ, nên retention không chặn đường xử lý chính. Lô ngắn hơn `N` (hết dòng đủ điều kiện, hoặc `readpast` bỏ qua dòng đang khóa)
  kết thúc chính sách đó; lượt kế tiếp sẽ làm tiếp.
- **Thứ tự chính sách** là thứ tự khóa ngoại: wallet `reconciliation_items` -> `reconciliation_runs` -> `outbox_sent` ->
  `processed_messages` -> `idempotency_keys` (item trước run, vì run chỉ xóa được khi không còn item); payment `webhook_attempts`
  -> `webhook_events` -> `idempotency_keys` (lần thử trước sự kiện).
- **Lỗi được cô lập**: lỗi của một (tenant, chính sách) được đếm và log `retention policy failed; continuing` (mức `warn`), rồi
  chạy tiếp phần còn lại. Lượt kết thúc log `retention run finished` (mức `info`, kèm `dryRun`, `errors`, `rows`, `policies` và `byTable` là danh sách tenant/table/count của lượt) khi
  có dòng được xóa/đếm hoặc có lỗi. Nếu cả lượt ném lỗi bất ngờ, worker log `retention run failed` (mức `error`).
- **Nhiều pod**: mỗi pod tự chạy retention. Hai pod làm việc trùng nhưng không sai (`readpast` giúp chúng không giẫm nhau); chấp
  nhận được. Mỗi pod báo metric của riêng nó.
- **Tồn đọng lớn cần nhiều lượt.** Lần bật xóa thật đầu tiên trên bảng đã lớn có thể không xóa hết trong một lượt (60 giây,
  1000 dòng/lô). Các lượt sau tiếp tục; nếu muốn nhanh hơn, xem "Sự cố thường gặp".

## Từ chạy thử sang xóa thật

Mặc định `RETENTION_ENABLED=true`, `RETENTION_DRY_RUN=true`. Ở chế độ chạy thử, mỗi chính sách chạy **một** câu đếm
(`select count(*) from (select top (1000000) ...)`) và **không xóa gì**. Quy trình:

1. **Để chạy thử vài lượt** (ít nhất vài chu kỳ `RETENTION_INTERVAL_MINUTES`, tốt nhất qua một ngày nghiệp vụ đầy đủ). Mỗi lượt
   chạy thử đếm lại **toàn bộ** dòng đủ điều kiện (vì không xóa gì) và cộng vào counter, nên counter `would_delete` là **tổng cộng
   dồn qua các lượt chạy thử**, không phải ước lượng của một lượt. Số theo từng lượt và từng bảng lấy từ log `retention run
   finished` có `dryRun: true` (trường `byTable`: tenant/table/count), hoặc từ mức tăng của counter giữa hai lượt liên tiếp
   (panel "Retention: số dòng đã xoá / sẽ xoá").
2. **So với kỳ vọng**: số đếm **một lượt** của từng bảng (từ `byTable` hoặc mức tăng giữa hai lượt, không phải giá trị cộng dồn)
   phải khớp ước lượng của bạn (ví dụ truy vấn trực tiếp số dòng cũ hơn ngưỡng). Số quá lớn hoặc quá nhỏ so với thực tế nghĩa là
   số ngày cấu hình chưa đúng ý, hoặc dữ liệu có hình dạng bạn chưa nghĩ tới: dừng và điều tra trước khi tiếp tục. Nhớ các giới
   hạn của số đếm thử (mục "Đọc số đếm").
3. **Điều chỉnh số ngày** nếu cần (`RETENTION_*_DAYS`), rồi để chạy thử thêm vài lượt để thấy số mới.
4. **Production: sao lưu database** (`billing_wallet`, `billing_payment`) trước khi bật xóa thật. Không có archive và không có
   cách hoàn tác ngoài khôi phục từ bản sao lưu.
5. **Bật xóa thật** bằng cách đặt biến môi trường rồi triển khai lại (khởi động lại) service tương ứng:

   ```bash
   RETENTION_DRY_RUN=false
   ```

   Làm lần lượt: một service, xem log/metric (`mode = deleted`, `errors` trong log), rồi service còn lại. Trên stack local, xem
   [local-stack](local-stack.vi.md) mục "Dọn dữ liệu".
6. Sau khi bật: theo dõi `billing.retention.last_success_timestamp_seconds` còn mới (rule `billing-retention-stalled` im lặng) và
   `deleted` giảm dần về gần 0 khi hết tồn đọng.

Muốn quay lại chạy thử: đặt `RETENTION_DRY_RUN=true` và triển khai lại. Muốn tắt hẳn job: `RETENTION_ENABLED=false` (hệ quả cho
cảnh báo ở mục dưới).

## Đọc metric, dashboard và cảnh báo

Hai metric (tên trong Elasticsearch xem [metric-fields](metric-fields.md)):

| Metric | Loại | Nhãn | Ý nghĩa |
| ------ | ---- | ---- | ------- |
| `billing.retention.rows` | counter (tích lũy, về 0 khi service khởi động lại) | `table` (tên chính sách), `mode`, và `tenant` (chỉ wallet) | Tổng số dòng đã xóa (`mode = deleted`) hoặc sẽ xóa (`mode = would_delete`, chế độ chạy thử). Chỉ tăng khi lượt có dòng (`count > 0`) |
| `billing.retention.last_success_timestamp_seconds` | gauge | (không có) | Epoch giây của lượt **gần nhất kết thúc không lỗi**; giữ nguyên giữa các lần xuất nên "tuổi" tăng dần cho tới lượt thành công kế tiếp |

**Một lượt có lỗi không làm mới gauge** (dù đã dọn được một phần), để cảnh báo "lâu không dọn" vẫn nổ khi retention liên tục lỗi.
Chạm ngân sách thời gian không phải lỗi.

Dashboard "Billing: vận hành" có 12 panel dữ liệu; hai panel của retention:

- **Retention: số dòng đã xoá / sẽ xoá (tích luỹ)**: counter `billing.retention.rows` theo `table / mode`, cộng qua các tenant;
  tụt về 0 sau khi service khởi động lại là bình thường.
- **Retention: số giây từ lần chạy thành công gần nhất**: tuổi của gauge theo service, kèm đường ngưỡng `maxAgeHours * 3600`
  giây của rule.

### Rule `billing-retention-stalled`

Rule thứ 9, mức `high`, chạy mỗi 15 phút. Mỗi service (`wallet`, `payment`) có `LAST(billing.retention.last_success_timestamp_seconds)`
trong `lookbackHours` giờ gần nhất (mặc định 24); rule báo khi giá trị đó cũ hơn `maxAgeHours` giờ (mặc định 3). Định danh alert
là cột `service`. Tham số và ràng buộc (`maxAgeHours` phải nhỏ hơn `lookbackHours`) xem
[kibana-alerts-and-dashboard](kibana-alerts-and-dashboard.vi.md). Các hành vi cần biết:

- **Job tắt (`RETENTION_ENABLED=false`) thì không có gauge nên rule không nổ.** Rule chỉ theo dõi service đã từng báo lần thành công
  trong `lookbackHours` giờ qua. Hệ quả: job chết hẳn trước khi từng báo thì không bị cảnh báo; nên kiểm tra ngay sau triển khai
  rằng gauge xuất hiện.
- **Rule tự hết sau `lookbackHours` giờ im lặng**: nếu retention ngừng báo thành công lâu hơn khoảng nhìn lại, service rời khỏi
  câu truy vấn và alert tự đóng dù vấn đề chưa được xử lý. Hãy xử lý trong khoảng đó, hoặc nâng `lookbackHours`.
- **Lượt có lỗi không làm mới gauge** (xem trên): lỗi kéo dài thì tuổi vượt `maxAgeHours` và rule nổ.
- Đồng hồ của service và Elasticsearch lệch nhau sẽ làm tuổi sai lệch tương ứng.

Khi rule nổ: xem log của service tìm `retention policy failed` / `retention run failed` (ví dụ DB không với tới được hoặc thiếu quyền), kiểm tra `RETENTION_ENABLED`, rồi xem mục "Sự cố thường gặp".

## Hành vi cần biết

- **Thứ tự tenant (wallet).** Mỗi lượt bắt đầu từ tenant đầu tiên của danh sách. Tồn đọng lớn ở một tenant đứng đầu có thể dùng hết
  ngân sách thời gian và làm các tenant sau bị bỏ đói cho tới khi tenant đầu dọn hết; gauge vẫn báo thành công trong thời gian đó
  (hết ngân sách không phải lỗi).
- **`idempotency_keys` của wallet bị xóa theo tuổi** kể cả khi `topup` liên kết chưa ở trạng thái cuối. Topup kẹt được phát hiện
  bởi cảnh báo topups-stuck, không phải bởi retention.
- **Nhiều pod.** Panel số dòng lấy MAX qua các pod, còn rule `billing-retention-stalled` lấy giá trị LAST theo service nên một pod
  lỗi liên tục có thể bị che khi pod khác vẫn báo thành công. Kiểm tra log `retention policy failed` của từng pod.

## Đọc số đếm: giới hạn của chế độ chạy thử

- **Trần 1.000.000 dòng mỗi chính sách trong một lượt.** Số đếm thử của một lượt không bao giờ vượt `1.000.000`; thấy đúng con
  số này trong `byTable` (hoặc mức tăng giữa hai lượt) nghĩa là "ít nhất bằng ấy". Số `deleted` thật không bị trần (mỗi lượt xóa nhiều lô cho tới hết ngân sách).
- **Chế độ chạy thử đếm một lần cho mỗi chính sách, không lặp.** Vì không có gì bị xóa, các chính sách phụ thuộc nhau chỉ thấy
  tình trạng hiện tại:
  - `reconciliation_runs` **đếm thiếu**: lượt còn item bị loại khỏi số đếm, trong khi ở chế độ thật item bị xóa trước (chính sách
    chạy trước run) nên nhiều lượt hơn sẽ đủ điều kiện.
  - `webhook_events` của payment **đếm thấp (bảo thủ)** trong lúc các lần thử còn tham chiếu sự kiện: sự kiện chỉ đủ điều kiện sau
    khi `webhook_attempts` của nó bị xóa. Số `webhook_events` thật sẽ lớn hơn số `would_delete` thấy khi chạy thử.
  - Các chính sách còn lại (`outbox_sent`, `processed_messages`, `idempotency_keys`, `reconciliation_items`, `webhook_attempts`)
    độc lập nên số đếm thử là số dòng đủ điều kiện tại thời điểm đếm (tối đa 1.000.000).
- Counter mỗi pod là riêng của pod đó; dashboard lấy MAX trong mỗi phút, không cộng các bản sao.
- **Counter `would_delete` là tổng dồn qua các lượt chạy thử** (xem "Từ chạy thử sang xóa thật"), nên giá trị lớn hơn nhiều lần ước
  lượng một lượt là bình thường.

## Tham chiếu cấu hình

Biến môi trường của cả hai service (mẫu trong `services/wallet/.env.example` và `services/payment/.env.example`). Boolean chỉ nhận
`true` hoặc `false`; số phải là số nguyên trong khoảng.

| Biến | Service | Mặc định | Khoảng hợp lệ | Ý nghĩa |
| ---- | ------- | -------- | ------------- | ------- |
| `RETENTION_ENABLED` | cả hai | `true` | `true` / `false` | `false` thì không tạo worker retention |
| `RETENTION_DRY_RUN` | cả hai | `true` | `true` / `false` | `true` chỉ đếm và log, không xóa; `false` xóa thật |
| `RETENTION_INTERVAL_MINUTES` | cả hai | 60 | 1 đến 1440 | Khoảng cách giữa hai lượt (phút) |
| `RETENTION_MAX_SECONDS_PER_RUN` | cả hai | 60 | 1 đến 3600 | Ngân sách thời gian mỗi lượt (giây), kiểm tra giữa các lô |
| `RETENTION_BATCH_SIZE` | cả hai | 1000 | 1 đến 4000 | Số dòng tối đa mỗi lô xóa |
| `RETENTION_OUTBOX_SENT_DAYS` | wallet | 14 | 1 đến 3650 | Giữ dòng outbox `SENT` bao nhiêu ngày |
| `RETENTION_PROCESSED_MESSAGES_DAYS` | wallet | 30 | 7 đến 3650 | Giữ `processed_messages` (inbox khử trùng) |
| `RETENTION_IDEMPOTENCY_KEYS_DAYS` | cả hai | 90 | 7 đến 3650 | Cửa sổ idempotency của `idempotency_keys` |
| `RETENTION_RECONCILIATION_DAYS` | wallet | 365 | 30 đến 3650 | Giữ mục/lượt đối soát đã đóng |
| `RETENTION_WEBHOOK_DAYS` | payment | 30 | 1 đến 3650 | Giữ webhook `DELIVERED` và lịch sử thử |

Index phục vụ các câu xóa nằm trong migration: wallet tenant migration `006-retention-indexes` (`ix_outbox_sent` có lọc
`status = 'SENT'`, `ix_processed_messages_at`, `ix_idempotency_keys_created`) và payment migration `003-retention-indexes`
(`ix_webhook_delivered` có lọc `status = 'DELIVERED'`, `ix_payment_idempotency_created`). `webhook_attempts` dùng khóa theo
`event_id` sẵn có.

## Sự cố thường gặp

| Triệu chứng | Nguyên nhân thường gặp | Cách xử lý |
| ----------- | ---------------------- | ---------- |
| Không thấy gauge/counter retention, rule không nổ | `RETENTION_ENABLED=false`, hoặc service chưa bật xuất metric (`OTEL_EXPORTER_OTLP_ENDPOINT`) | Kiểm tra biến môi trường; log lúc khởi động; với metric xem [local-stack](local-stack.vi.md) |
| Job chạy nhưng không bao giờ báo thành công | Mỗi lượt đều có lỗi (log `retention policy failed; continuing`) hoặc worker ném lỗi (log `retention run failed`) | Đọc trường `err` của log: ví dụ mất kết nối DB, hoặc (chỉ với tài khoản được cấp quyền tùy chỉnh) thiếu quyền xóa; `deploy/sql/init.sql` cấp `db_datawriter` nên cấu hình mặc định đã đủ quyền |
| Truy vấn xóa chậm, quét cả bảng | Thiếu index của migration retention (wallet `006` chưa áp cho một tenant, payment `003` chưa chạy). Migration chỉ thêm index nên thiếu index chỉ làm xóa chậm, không gây lỗi | Chạy lại migration (job `migrate` trên stack local); service wallet từ chối khởi động nếu còn tenant chưa migrate |
| Xóa chậm, tồn đọng mãi không hết | Mỗi lượt chỉ có 60 giây và lô 1000 dòng | Nâng `RETENTION_BATCH_SIZE` (tối đa 4000), nâng `RETENTION_MAX_SECONDS_PER_RUN`, hoặc hạ `RETENTION_INTERVAL_MINUTES`; hoặc đơn giản để nhiều lượt dọn dần |
| Số đếm thử của một lượt (trong `byTable` hoặc mức tăng giữa hai lượt) luôn đúng bằng 1.000.000 | Trần của chế độ chạy thử | Bình thường với tồn đọng rất lớn; số thật lớn hơn |
| Counter `would_delete` lớn gấp nhiều lần ước lượng | Counter cộng dồn số đếm của mọi lượt chạy thử (mỗi lượt đếm lại cùng các dòng) | Không phải lỗi; dùng `byTable` hoặc mức tăng giữa hai lượt |
| `would_delete` của `webhook_events` / `reconciliation_runs` thấp bất thường | Giới hạn đếm thử của các chính sách phụ thuộc (xem mục "Đọc số đếm") | Không phải lỗi; sau khi xóa thật các bảng con, các dòng này đủ điều kiện ở lượt sau |
| Service không khởi động, `ConfigError` | Số ngày dưới mức tối thiểu, ngoài khoảng, hoặc boolean khác `true`/`false` | Sửa theo thông báo, đối chiếu bảng "Tham chiếu cấu hình" |

## Liên quan

[ADR-0012](../adr/0012-batched-dry-run-first-retention.vi.md), [spec 6b](../superpowers/specs/2026-10-12-retention-design.md),
[kibana-alerts-and-dashboard](kibana-alerts-and-dashboard.vi.md), [local-stack](local-stack.vi.md),
[reconciliation-runbook](../integration/reconciliation-runbook.vi.md).
