# Cảnh báo và dashboard Kibana của billing

Tài liệu cho người vận hành: billing có 8 rule cảnh báo và một dashboard "Billing: vận hành" trên Kibana, tất cả **sinh từ code**
và chỉnh được bằng tham số. Thiết kế: [spec 6a](../superpowers/specs/2026-10-11-ops-metrics-alerts-design.md); quyết định:
[ADR-0011](../adr/0011-otel-metrics-and-generated-kibana-rules.vi.md); tên trường metric trong Elasticsearch:
[metric-fields](metric-fields.md); chạy thử trên máy: [local-stack](local-stack.vi.md).

## Cách hoạt động

```text
params.defaults.json (+ params.local.json)  ->  bộ sinh (tools/kibana)  ->  kibana:apply  ->  Kibana (rule + dashboard)
```

1. `deploy/kibana/params.defaults.json` (đã commit) chứa mọi giá trị mặc định; `deploy/kibana/params.local.json` (git-ignored,
   tùy chọn) chỉ ghi các khóa muốn đổi và được trộn sâu lên mặc định.
2. Tham số được kiểm tra trước khi gọi Kibana: sai kiểu, ngoài khoảng, khóa lạ hay thiếu đều bị từ chối kèm đường dẫn khóa.
3. Bộ sinh (`tools/kibana/rules.ts`, `dashboard.ts`) dựng 8 rule và dashboard với **ID cố định** theo tên, nên cập nhật tại chỗ
   thay vì tạo bản trùng.
4. `corepack pnpm kibana:apply` tạo hoặc cập nhật rule qua Alerting API và import dashboard qua Saved Objects API.
5. Điều kiện của rule và đường ngưỡng của dashboard dùng **cùng** tham số, nên đổi một ngưỡng là đổi cả hai.

Yêu cầu stack: **Kibana và Elasticsearch từ 9.4** (`MIN_STACK_VERSION = 9.4.0` trong `tools/kibana/rules.ts`). Mọi câu ES|QL
bắt đầu bằng `SET unmapped_fields="nullify";` (metric chưa có dữ liệu thành null thay vì lỗi) và panel dùng Lens ES|QL; hai thứ
này cần 9.4. `kibana:apply` và `kibana:verify` từ chối chạy trên stack cũ hơn với thông báo
`Kibana <x> is older than the minimum 9.4.0 ...`. Định dạng saved object bám theo Kibana 9.4.4 (bản stack local dùng).

## Các rule

Mỗi rule gắn tag `billing` và tag mức độ; mô tả của rule nêu runbook cần mở. Rule chỉ tạo alert trong Kibana: **chưa có
connector thông báo** (email, Slack) nào được gắn, việc đó là hạ tầng của người vận hành.

| Rule                                 | Báo khi                                                                                             | Việc cần làm                                                                    |
| ------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `billing-dlq-not-empty`              | `wallet.order-payments.dlq` luôn có thư (độ sâu nhỏ nhất trong cửa sổ > `minDepth`)                 | [dlq-runbook](../integration/dlq-runbook.vi.md)                                 |
| `billing-outbox-stuck`               | Thư outbox cũ nhất của một tenant chờ quá `thresholdSeconds`                                        | [orders-handoff](../integration/orders-handoff.vi.md)                           |
| `billing-topups-stuck`               | Yêu cầu nạp tiền cũ nhất của một tenant chờ quá `thresholdSeconds`                                  | README mục Wallet                                                               |
| `billing-ledger-integrity`           | Có mục đối soát mở loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH` (số mục mở > `minOpenItems`)    | [reconciliation-runbook](../integration/reconciliation-runbook.vi.md)           |
| `billing-reconciliation-stale-cases` | Mục đối soát mở cũ nhất của một tenant quá `maxAgeHours` giờ                                        | [reconciliation-runbook](../integration/reconciliation-runbook.vi.md)           |
| `billing-reconciliation-missed`      | Lượt đối soát `COMPLETED` gần nhất của một tenant cách đây quá `maxAgeHours` giờ                    | [reconciliation-runbook](../integration/reconciliation-runbook.vi.md)           |
| `billing-reconciliation-failed-run`  | Có lượt đối soát `FAILED` mới trong cửa sổ (tổng số lượt `FAILED` tăng thêm ở mọi tiến trình > 0)   | [reconciliation-runbook](../integration/reconciliation-runbook.vi.md)           |
| `billing-service-silent`             | `wallet` hoặc `payment` đã từng gửi metric trong `lookbackHours` giờ qua nhưng im quá `silentMinutes` | README mục Wallet; kiểm tra collector và `OTEL_EXPORTER_OTLP_ENDPOINT` của service |

## Bảng tham số

Mọi khóa nằm trong `params.defaults.json`; thiếu hay thừa khóa so với bảng này đều bị `kibana:apply` từ chối (và
`tools/kibana/docs.test.ts` đảm bảo bảng này luôn đủ tên rule và tên khóa).

### Khóa dùng chung của mọi rule (`rules.<tên rule>.<khóa>`)

| Khóa              | Ý nghĩa                                                                                                   | Khoảng hợp lệ                |
| ----------------- | --------------------------------------------------------------------------------------------------------- | ---------------------------- |
| `enabled`         | Rule bật hay tắt. Đây là **thứ duy nhất** `apply` dùng để bật/tắt rule                                    | `true` / `false`             |
| `severity`        | Mức độ; thành tag của rule                                                                                | `critical`, `high`, `warning` |
| `intervalMinutes` | Chu kỳ chạy rule                                                                                          | số nguyên 1 đến 60           |
| `windowMinutes`   | Cửa sổ nhìn lại của câu ES\|QL và của rule (riêng `billing-service-silent` dùng `lookbackHours`, xem dưới) | số nguyên 1 đến 1440         |

Giá trị mặc định của các khóa dùng chung:

| Rule                                 | `enabled` | `severity` | `intervalMinutes` | `windowMinutes` |
| ------------------------------------ | --------- | ---------- | ----------------- | --------------- |
| `billing-dlq-not-empty`              | `true`    | `critical` | 1                 | 5               |
| `billing-outbox-stuck`               | `true`    | `high`     | 1                 | 5               |
| `billing-topups-stuck`               | `true`    | `high`     | 1                 | 5               |
| `billing-ledger-integrity`           | `true`    | `critical` | 1                 | 5               |
| `billing-reconciliation-stale-cases` | `true`    | `warning`  | 15                | 30              |
| `billing-reconciliation-missed`      | `true`    | `high`     | 15                | 30              |
| `billing-reconciliation-failed-run`  | `true`    | `high`     | 5                 | 30              |
| `billing-service-silent`             | `true`    | `high`     | 1                 | 5 (không dùng)  |

`billing-service-silent` luôn dùng cửa sổ `lookbackHours * 60` phút; khóa `windowMinutes` của nó vẫn bắt buộc có và được kiểm
tra, nhưng không ảnh hưởng gì.

### Khóa riêng của từng rule

| Rule                                 | Khóa               | Ý nghĩa                                                                        | Mặc định | Khoảng hợp lệ       |
| ------------------------------------ | ------------------ | ------------------------------------------------------------------------------ | -------- | ------------------- |
| `billing-dlq-not-empty`              | `minDepth`         | Báo khi độ sâu DLQ nhỏ nhất trong cửa sổ **lớn hơn** giá trị này               | 0        | 0 đến 1.000.000     |
| `billing-outbox-stuck`               | `thresholdSeconds` | Tuổi tối đa (giây) của thư outbox chưa gửi                                     | 300      | 1 đến 604.800       |
| `billing-topups-stuck`               | `thresholdSeconds` | Tuổi tối đa (giây) của yêu cầu nạp tiền chưa hoàn tất                          | 300      | 1 đến 604.800       |
| `billing-ledger-integrity`           | `minOpenItems`     | Báo khi số mục mở của loại toàn vẹn **lớn hơn** giá trị này                    | 0        | 0 đến 1.000.000     |
| `billing-reconciliation-stale-cases` | `maxAgeHours`      | Tuổi tối đa (giờ) của một ca đối soát còn mở                                   | 24       | 1 đến 720           |
| `billing-reconciliation-missed`      | `maxAgeHours`      | Tuổi tối đa (giờ) của lượt đối soát thành công gần nhất (lịch chạy mỗi ngày)   | 26       | 1 đến 720           |
| `billing-reconciliation-failed-run`  | (không có)         | Chỉ có các khóa dùng chung; báo khi có bất kỳ lượt `FAILED` mới trong cửa sổ   | -        | -                   |
| `billing-service-silent`             | `silentMinutes`    | Số phút không có metric nào thì coi service là im                              | 5        | 1 đến 1440          |
| `billing-service-silent`             | `lookbackHours`    | Chỉ xét service đã gửi metric trong khoảng này; im lâu hơn thì rule tự hết báo | 6        | 1 đến 168           |

### Dashboard (`dashboard.<khóa>`)

| Khóa             | Ý nghĩa                                                                      | Mặc định  | Khoảng hợp lệ                                  |
| ---------------- | ---------------------------------------------------------------------------- | --------- | ---------------------------------------------- |
| `timeRange`      | Khoảng thời gian mặc định của dashboard (lưu cùng dashboard)                 | `now-6h`  | dạng `now-<số>[m\|h\|d]`, ví dụ `now-30m`, `now-7d` |
| `refreshSeconds` | Chu kỳ tự làm mới; `0` là tắt tự làm mới                                     | 60        | số nguyên 0 đến 3600                           |

## Quy trình đổi tham số

1. Tạo hoặc sửa `deploy/kibana/params.local.json`, chỉ ghi khóa muốn đổi.
2. `corepack pnpm kibana:apply -- --dry-run`: chỉ đọc Kibana, in từng rule sẽ `create`, `update`, `enable`, `disable` hay
   `unchanged` kèm khía cạnh khác nhau (`name`, `tags`, `schedule`, `params`, `enabled`). Dòng cuối cho dashboard chỉ nêu số object
   sẽ import, không liệt kê khác biệt.
3. `corepack pnpm kibana:apply`: áp thật. Chạy lại lần nữa phải thấy mọi rule `unchanged`.
4. Kiểm tra trên Kibana (Stack Management, Rules, tìm tag `billing`; và dashboard "Billing: vận hành"), hoặc chạy
   `corepack pnpm kibana:verify` (xem [local-stack](local-stack.vi.md)).

`kibana:apply` đọc địa chỉ Kibana từ `KIBANA_URL` (mặc định `http://localhost:15601`, cổng của stack local) hoặc cờ
`--kibana-url <url>`; cùng lệnh dùng được cho Kibana khác. Dùng `--params-local <đường dẫn>` để trỏ tới file tham số khác.

### Ví dụ

Nâng ngưỡng outbox lên 600 giây, tắt rule `billing-service-silent` và cho dashboard mở với 24 giờ gần nhất.
`deploy/kibana/params.local.json`:

```json
{
  "rules": {
    "billing-outbox-stuck": { "thresholdSeconds": 600 },
    "billing-service-silent": { "enabled": false }
  },
  "dashboard": { "timeRange": "now-24h" }
}
```

```bash
corepack pnpm kibana:apply -- --dry-run
# update  billing-outbox-stuck  [params]
# disable  billing-service-silent  [enabled]
# (các rule khác: unchanged)
# dashboard: would import 5 objects (dry run)

corepack pnpm kibana:apply
```

Đường ngưỡng "threshold" trên biểu đồ outbox cũng chuyển sang 600 vì dashboard đọc cùng tham số.

### Quay lại mặc định (rollback)

Xóa khóa đó khỏi `params.local.json` (hoặc xóa cả file) rồi `corepack pnpm kibana:apply`: tham số về mặc định, rule tắt bằng
`enabled: false` được bật lại.

## `apply` làm gì và không làm gì

- **Cập nhật tại chỗ** theo ID cố định: rule chưa có thì tạo, có rồi thì `PUT` khi tham số khác; không tạo bản trùng. **Lịch sử
  alert được giữ** vì rule không bị xóa-tạo lại.
- Bật/tắt rule **chỉ** theo `enabled` trong tham số (mặc định `true`). Hệ quả: rule bạn tắt tay trên giao diện sẽ được **bật lại**
  ở lần `apply` sau. Muốn tắt bền vững, đặt `enabled: false` trong `params.local.json`.
- **Không bao giờ xóa rule.** Rule có tag `billing` mà công cụ không quản lý (ví dụ rule cũ đã bị bỏ khỏi code) chỉ được **báo**
  ở cuối kết quả (`warning: N rule(s) tagged billing are not managed by this tool (not deleted)`); xóa tay nếu cần.
- **Sửa tay trên giao diện Kibana bị ghi đè** (tên, tag, lịch, điều kiện ES|QL) ở lần `apply` sau; `--dry-run` cho thấy các khác
  biệt đó là `[params]`, `[schedule]`... Mọi thay đổi bền vững phải đi qua tham số hoặc code. Dashboard luôn được import ghi đè,
  nên sửa tay dashboard cũng mất; muốn giữ bản sửa, lưu thành dashboard khác.
- **`actions` (connector thông báo) không được quản lý**: rule sinh ra không có action, và `apply` không so sánh action. Lần cập
  nhật một rule gửi `actions` rỗng, nên connector gắn tay vào rule đó có thể bị gỡ khi rule được cập nhật (rule `unchanged` thì
  không bị chạm). Chưa kiểm chứng trên Kibana thật; cần thông báo ổn định thì đợi bước cấu hình connector chính thức.
- `apply` chờ Kibana sẵn sàng tối đa 120 giây, kiểm tra phiên bản stack (xem trên) rồi mới ghi.

## Import tay (không có API)

```bash
corepack pnpm kibana:build -- --out ./kibana-export
```

Ghi `billing-alerts.ndjson` và `billing-dashboard.ndjson` vào thư mục đó từ tham số hiện tại (có cả `params.local.json`). Trên
Kibana: Stack Management, Saved Objects, Import, chọn từng file. **Rule import vào ở trạng thái tắt** (hành vi của Kibana khi
import rule): phải vào Rules và bật từng rule. Vì vậy đường khuyến nghị là `kibana:apply`; import tay chỉ cho Kibana mà máy
chạy lệnh không với tới được.

> **Cảnh báo:** `kibana:build` **không** kèm `--out` ghi vào chính `deploy/kibana/*.ndjson` (file đã commit) và dùng cả
> `params.local.json`, nên ngưỡng cục bộ của bạn sẽ lọt vào file commit. Hai file commit phải ứng với tham số mặc định: chỉ
> tái tạo chúng bằng `corepack pnpm kibana:build -- --defaults-only`, và luôn dùng `--out <thư mục>` khi xuất để import tay.

## Đọc dashboard và rule đúng cách

- **Counter là tích lũy và về 0 khi service khởi động lại.** Các biểu đồ đếm (đơn thanh toán, message consumer, charge, webhook)
  thấy "tụt về 0" sau khi deploy là bình thường, không phải mất dữ liệu. Mỗi tiến trình có `service.instance.id` riêng (một chuỗi
  mới sau mỗi lần khởi động); dashboard gộp counter bằng **MAX** trong mỗi phút (không cộng các bản sao), còn rule
  `billing-reconciliation-failed-run` cộng mức tăng của từng tiến trình nên không báo nhầm khi service khởi động lại.
- **Gauge lấy giá trị mới nhất (`LAST`) trong cửa sổ.** Khi một chuỗi ngừng được báo (ví dụ số mục mở của một loại lệch từ 1 về 0
  thì metric đó không còn được phát), rule dùng `LAST` có thể vẫn **active tối đa một cửa sổ** (`windowMinutes`) sau khi sự việc đã
  hết, rồi tự hết. Bảng "Open reconciliation cases by kind" có thể hiển thị số cũ vì lý do tương tự.
- `billing-service-silent` tự hết báo sau `lookbackHours` giờ im lặng, và **không bao giờ báo** cho service chưa từng gửi metric
  (danh sách `wallet`, `payment` nằm cứng trong câu ES|QL). Khi DB sập, các gauge lấy từ DB biến mất; rule này chỉ bắt được
  trường hợp service ngừng gửi hẳn.
- Biểu đồ "Active billing alerts" đọc chỉ mục alert của Kibana, không phụ thuộc thanh thời gian.
- Các bảng (3 panel dạng bảng) là saved search ES|QL tham chiếu từ dashboard, được import cùng dashboard.
- **Tiêu đề panel hiện bằng tiếng Anh** (ví dụ "DLQ depth", "Active billing alerts"); Việt hóa là việc tiếp theo, không ảnh hưởng
  dữ liệu hay tham số.

## Liên quan

[ADR-0011](../adr/0011-otel-metrics-and-generated-kibana-rules.vi.md), [local-stack](local-stack.vi.md),
[metric-fields](metric-fields.md), [dlq-runbook](../integration/dlq-runbook.vi.md),
[reconciliation-runbook](../integration/reconciliation-runbook.vi.md).
