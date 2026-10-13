# Chaos test: cách chạy, kiến trúc công cụ và giới hạn

Tài liệu cho người phát triển và người vận hành test: bộ chaos test (`tests/chaos`) cố tình làm hỏng SQL Server, RabbitMQ, đường HTTP
giữa wallet và payment, rồi cả chính tiến trình dịch vụ, sau đó kiểm tra các cam kết về tiền vẫn còn đúng. Mục đích chính là **tìm lỗi
thật**, không chỉ thêm test. Thiết kế: [spec 6d](../superpowers/specs/2026-10-12-chaos-tests-design.md); quyết định:
[ADR-0014](../adr/0014-chaos-tests-in-process-and-child.vi.md); kết quả và ghi chú vận hành rút ra:
[chaos-findings](chaos-findings.vi.md).

> Chaos test chạy trên **hạ tầng dựng riêng bằng testcontainers** (một SQL Server và một RabbitMQ dùng chung cho cả lượt chạy,
> mỗi hệ có database và vhost riêng). Nó **không dùng** stack `billing-local` của [local-stack](local-stack.vi.md) và không bao giờ
> nên được trỏ vào môi trường dùng chung.

## Các cam kết được kiểm tra (8 bất biến)

Sau mỗi kịch bản (và sau mỗi vòng soak), một **oracle** dùng chung (`tests/chaos/support/invariants.ts`) đọc lại toàn bộ trạng thái
của mọi tenant và đối chiếu:

| Mã | Cam kết | Ví dụ vi phạm mà oracle báo (`code`) |
| -- | ------- | ------------------------------------ |
| INV-1 | Sổ cái cân bằng: tổng số dư theo từng đồng tiền bằng 0, số dư mỗi tài khoản bằng tổng các dòng của nó, mỗi giao dịch cân, không giao dịch rỗng | `TOTAL_NONZERO`, `BALANCE_DRIFT`, `TX_UNBALANCED`, `TX_EMPTY` |
| INV-2 | Mỗi order chỉ bị ghi nợ một lần; `order_payments` khớp sổ cái; mọi `OrderPaidV1` Orders nhận cho cùng order mang cùng `walletTransactionId` và số tiền | `ORPHAN_ORDER_TX`, `ORDER_PAYMENT_AMOUNT_MISMATCH`, `RECEIVED_PAID_MISMATCH` |
| INV-3 | Nạp tiền khớp giữa wallet và payment: mỗi topup `SUCCEEDED` có đúng một giao dịch `TOPUP` và một charge `SUCCEEDED` khớp; tổng `TOPUP` bằng tổng charge `SUCCEEDED` theo tenant và đồng tiền; mỗi reference và mỗi idempotency key chỉ một charge | `TOPUP_TX_MISSING`, `CHARGE_TOPUP_NOT_SUCCEEDED`, `SUM_MISMATCH`, `DUPLICATE_CHARGE_REF` |
| INV-4 | Outbox ít nhất một lần: không còn dòng chưa `SENT`; mọi kết quả đã `SENT` và mọi order đã trả đều tới Orders giả; không có `OrderPaidV1` cho order chưa trả | `OUTBOX_NOT_SENT`, `SENT_NOT_RECEIVED`, `PAID_NOT_RECEIVED`, `OUTBOX_PAID_UNKNOWN_ORDER` |
| INV-5 | Đối soát hội tụ: chạy đối soát thật cho mọi tenant và mọi ngày UTC có dữ liệu; không còn sai lệch `OPEN`; mọi `MISSING_AT_WALLET` được ghi bù đúng một lần; lượt đối soát thứ hai không thấy gì | `RECONCILIATION_RUN_FAILED`, `MISSING_AT_WALLET_UNFIXED`, `AUTOFIX_UNEXPECTED`, `RECONCILIATION_NOT_CONVERGED` |
| INV-6 | Thao tác ops nguyên tử: mỗi dòng `ops_actions` có đúng hiệu ứng trong sổ cái và ngược lại; thử lại cùng khóa không nhân đôi | `ADJUST_TX_MISSING`, `REVERSE_ACTION_DUPLICATE`, `FREEZE_STATE_MISMATCH`, `REPLAY_OUTBOX_MISSING` |
| INV-7 | Thứ client đã được xác nhận thành công vẫn còn nguyên (đặc biệt khi retention thật chạy): order Orders đã nhận `OrderPaidV1`, `topupId` đã trả, `actionId` ops đã trả | `ACKED_ORDER_MISSING`, `ACKED_TOPUP_MISSING`, `ACKED_OPS_ACTION_MISSING` |
| INV-8 | Phục hồi: cả hai dịch vụ `GET /health` = 200 và đọc được qua pool DB của chính chúng trong 10 giây; không tiến trình con nào còn chết | `HEALTH_FAILED`, `READ_FAILED`, `SERVICE_DOWN` |

Danh sách đầy đủ mã vi phạm nằm ở chú thích đầu `tests/chaos/support/invariants.ts`; mã là ổn định để phân loại bằng máy.

### Thứ tự kiểm tra của oracle

`assertSystemInvariants(system, options?)` chạy theo thứ tự cố định, vì đối soát có **ghi bù** (autofix) và có thể che lỗi:

1. INV-1, INV-2, INV-4 chặt (chỉ đọc; đối soát không bao giờ đụng tới order hay outbox).
2. INV-3 **trước** đối soát: phải rỗng. Ngoại lệ duy nhất là `expectMissingAtWallet: true` (webhook bị mất có chủ ý, kịch bản S7):
   khi đó INV-3 chỉ được còn đúng các trạng thái `MISSING_AT_WALLET` (charge `SUCCEEDED`, topup `REQUESTED`/`PENDING`, hoặc `FAILED`
   với `PAYMENT_UNAVAILABLE`, kèm đúng chênh lệch tổng tiền), và webhook của các charge đó **không** được ở trạng thái `DELIVERED`. Nếu
   wallet đã trả 2xx mà không ghi có thì luôn là lỗi (`MISSING_AT_WALLET_WEBHOOK_DELIVERED`), không bao giờ được miễn.
3. INV-8 (cần wallet sống để đối soát).
4. Chỉ khi các bước 1-3 sạch: INV-5, tức đối soát qua API HTTP của wallet cho mọi tenant và mọi ngày UTC suy ra **từ dữ liệu** (không từ
   đồng hồ), rồi một lượt thứ hai kiểm hội tụ; sau đó **kiểm lại INV-1..4 chặt** (không còn miễn trừ nào) để chứng minh ghi bù đúng một
   lần. Có vi phạm ở bước 1-3 thì không chạy đối soát, để autofix không đổi hiện trường.
5. INV-6, INV-7; các vi phạm INV-8 được gom cuối.

`collectViolations` là một lượt **chỉ đọc** (không có INV-5) dùng khi cần xem nhanh một vài bất biến (`only: ['INV-1', 'INV-6']`).
Phần đọc phía wallet của INV-3 chạy trong **một giao dịch snapshot** và đọc wallet trước payment, nên không thể thấy trạng thái lệch pha
do một lần nạp hoàn tất giữa hai truy vấn.

Oracle có **test riêng** (`tests/chaos/invariants.chaos.test.ts`): với từng bất biến, test cố ý làm hỏng trạng thái (giao dịch trùng,
số dư lệch, outbox thiếu, charge trùng, lượt đối soát không hội tụ...) và xác nhận oracle ném đúng mã vi phạm, kể cả việc nó **không** chạy
đối soát khi bước chặt đã hỏng.

## Cách chạy

Yêu cầu: Node 22, **Docker** (testcontainers kéo và chạy `mcr.microsoft.com/mssql/server:2022-latest` và `rabbitmq:3-management-alpine`;
lần đầu kéo image). Dùng tiền tố `corepack pnpm` như phần còn lại của repo.
```bash
corepack pnpm test:chaos                 # toàn bộ kịch bản S1-S13, test công cụ và một vòng soak ngắn (seed cố định)
corepack pnpm test:chaos:soak            # bài soak dài, ngẫu nhiên (chạy riêng, không nằm trong test:chaos)
```

Không dùng `--` khi lọc (giống `test:integration`). Chạy một tệp hoặc một kịch bản:

```bash
corepack pnpm test:chaos scenarios-sql-broker            # S1-S5 (một tệp)
corepack pnpm test:chaos scenarios-payment-crash -t S9   # một kịch bản theo tên
corepack pnpm test:chaos invariants                      # chỉ test của oracle
```

`test:chaos` lấy mọi tệp `tests/chaos/**/*.chaos.test.ts` (`vitest.chaos.config.ts`); `test:chaos:soak` lấy `tests/chaos/**/*.soak.test.ts`
(`vitest.chaos-soak.config.ts`, timeout 1 giờ, in console của test đạt để thấy dòng `chaos seed=...`). Cả hai chạy tuần tự từng tệp
(`fileParallelism: false`) và dùng lại `globalSetup` của `@billing/testing`. Các tệp `*.chaos.test.ts` bị loại khỏi `corepack pnpm test`
và `test:integration`; còn các test thuần của công cụ (`prng`, `fault-plan`, `op-log`, `quiesce`, proxy HTTP, `service-config`, `broker-faults`
dạng `*.test.ts`) chạy trong `corepack pnpm test` (không cần Docker).

### Biến môi trường

| Biến | Dùng ở | Ý nghĩa | Mặc định |
| ---- | ------ | ------- | -------- |
| `CHAOS_SEED` | mọi lệnh | Số nguyên thập phân `0..4294967295`. Quyết định kế hoạch tải và lịch lỗi của soak, và xác suất của rule dùng `probability` | `test:chaos`: vòng soak ngắn dùng seed **1**; `test:chaos:soak`: **ngẫu nhiên** (luôn in ra). Kịch bản S1-S13 không dựa vào seed (không có rule xác suất) nên seed chỉ để đặt tên nhật ký |
| `CHAOS_ROUNDS` | `test:chaos:soak` | Số vòng soak liên tiếp (số nguyên dương) | 3 |
| `CHAOS_MAX_SECONDS` | `test:chaos:soak` | Thời gian chịu tải của **mỗi vòng**, giây (số nguyên dương) | 30 |
| `CHAOS_MODE` | `test:chaos:soak` | `inproc`, `child` hoặc `mixed` (vòng lẻ chạy `inproc`, vòng chẵn chạy `child`) | `mixed` |

Giá trị không hợp lệ làm test ném lỗi ngay (không đoán). Vòng soak ngắn trong `test:chaos` cố định `inproc`, 1 vòng, 15 giây, và chỉ đọc `CHAOS_SEED`.
Vitest ẩn console của test đạt, nên để thấy dòng `chaos seed=<n> rounds=<m> mode=<mode>` và dòng tóm tắt từng vòng khi chạy `test:chaos`, thêm `--silent=false`.

### Thời gian điển hình

Đo trên máy phát triển Windows có Docker (số thực tế phụ thuộc máy, lần đầu kéo image):

- Khoảng 9m40s-9m50s cho toàn bộ `test:chaos` gồm 143 test, **lúc bài soak còn là 3 vòng x 30 giây trộn `inproc`/`child` nằm trong `test:chaos`**. Sau khi tách bài dài ra `test:chaos:soak`, `test:chaos` chỉ còn một vòng 15 giây nên ngắn hơn (xem số đo cuối mục này).
- Tệp kịch bản payment/crash (S6-S10, có hai kịch bản tiến trình con): 89-99 giây. Tiến trình con chậm hơn trong tiến trình (khởi động `tsx` mất vài giây mỗi lần dựng lại).
- Soak dài, mỗi vòng 30 giây, `mixed`: 2m40s-3m54s cho 3 vòng (cả dựng hệ, `heal` và oracle); 4 vòng x 60 giây: 7m15s-7m52s.
- Mỗi lần gọi `assertSystemInvariants` mất khoảng 1-2 giây (đối soát thật nằm trong đó), nên mỗi kịch bản chỉ gọi một lần.

## Kiến trúc công cụ (`tests/chaos/support/`)

Không thuộc code production; chỉ test dùng. Production chỉ có hai seam test-only, mặc định không làm gì (ADR-0014):

- `createDatabase(config, { wrapDialect })` trong `packages/database`: bọc `Dialect` của Kysely trước khi tạo `Kysely`.
- `StartOverrides.wrapDialect` (wallet và payment) truyền xuống `createDatabase`, và `StartOverrides.wrapPublisher` (chỉ wallet) bọc
  `EventPublisher` của relay outbox. Hook `afterOrderHandled` có sẵn từ trước (chạy sau khi `PayOrder` commit, trước ack) cũng được dùng.

| Thành phần | Tệp | Vai trò |
| ---------- | --- | ------- |
| `FaultPlan` | `fault-plan.ts` | Danh sách rule `{point, when?, nth?, probability?, times?, label?, action}`. Mã bọc gọi `plan.hit(point, info)`; rule khớp thì chạy `action` (ném lỗi, sửa `info.decision`, chạy `KILL`...). `nth` đếm số lần **khớp** `when`; `probability` rút từ prng của seed. `plan.fired(label)` và `plan.hits(point)` để test chờ lỗi **thực sự** xảy ra. `plan.disable()`/`enable()`/`clear()`. Mỗi lần bắn ghi vào `OpLog` |
| Dialect có lỗi | `sql-faults.ts` | `faultyDialect(plan, { name })` bọc driver MSSQL: gọi `hit` ở `sql.query.before`/`sql.query.after` (mang `info.sql`, đã hạ chữ thường), `sql.begin.after`, `sql.commit.before`/`sql.commit.after`, `sql.rollback.before`; `info.connection` là mã của lần lấy kết nối nên phân biệt được transaction đồng thời. `killSessions(config)` chạy `KILL` từng session của đúng database test (từ chối `master`/`tempdb`/`model`/`msdb`), qua kết nối quản trị riêng tới `master` |
| Publisher có lỗi | `broker-faults.ts` | `faultyPublisher(plan)` bọc `EventPublisher`: rule ở `broker.publish.before` ném lỗi thì message mất; ở `broker.publish.after` ném lỗi thì message **đã tới broker** nhưng publisher báo `failed` (mất ack). `dropBrokerConnections(broker, 'billing_wallet')` đóng kết nối AMQP của riêng wallet (không đụng kết nối của Orders giả) |
| `HttpFaultProxy` | `http-fault-proxy.ts` | Hai proxy HTTP: `wallet-to-payment` (tạo charge) và `payment-to-wallet` (webhook). Mỗi request gọi `<name>.request`; rule đặt `info.decision` = `forward` \| `drop` \| `duplicate` \| `{ status, body? }` \| `{ delayMs }`. Sau khi mục tiêu xử lý, `<name>.response` được gọi **trước** khi trả cho client: action ném ở đây = mục tiêu đã xử lý nhưng client không thấy phản hồi. Ghi `log` và `duplicateStatuses` (mã của bản gửi thứ hai) |
| Hệ thống | `system-harness.ts`, `service-config.ts` | `createSystem(options)` dựng: DB wallet và DB payment riêng, vhost riêng, "Orders giả" (`OrdersSimulator`, ghi mọi sự kiện nhận được), hai proxy, wallet và payment. Cấu hình dịch vụ đặt một chỗ (`service-config.ts`): chế độ `inproc` truyền thẳng, chế độ `child` đổi chính cấu hình đó thành biến môi trường |
| Tiến trình con | `crash.ts`, `child-guard.mjs` | `mode: 'child'`: mỗi dịch vụ là tiến trình Node thật `node --import child-guard.mjs --import tsx services/<tên>/src/main.ts` (pid chính là dịch vụ). `crashWallet()`/`crashPayment()` = `SIGKILL` (Windows: `TerminateProcess`) rồi đợi thoát, **không** tự bật lại; `restartWallet()`/`restartPayment()` hoặc `heal()` dựng lại trên cùng DB và vhost. `child-guard` làm tiến trình con tự thoát khi cha chết (pipe stdin đóng), ngoài ra `stop()` giết và xác nhận mọi pid đã từng sinh |
| `quiesce` | `quiesce.ts` | Thăm dò (mặc định 200 ms) tới khi mọi điều kiện đạt; điều kiện ném lỗi coi là chưa đạt; hết hạn thì ném lỗi nêu **tên điều kiện chưa đạt** và lỗi cuối. Không có `sleep` cố định trong kịch bản |
| `prng` | `prng.ts` | mulberry32 theo seed; `fork(label)` sinh dòng con chỉ phụ thuộc (seed gốc, label), không phụ thuộc mức tiêu thụ của cha |
| `OpLog` | `op-log.ts` | Nhật ký thao tác có mốc thời gian; `writeTo(dir, name)` ghi một tệp JSON (mảng các mục) |
| Oracle | `invariants.ts` | Như mục trên |
| Soak | `soak.ts` | Bộ sinh tải, lịch lỗi và `runSoakRounds` |

### Chế độ `inproc` và `child`

- **`inproc` (mặc định):** wallet và payment chạy ngay trong tiến trình test, có đủ `faultyDialect`, `faultyPublisher`, `afterOrderHandled`,
  proxy, `killSessions` và `dropWalletBrokerConnections`. Nhanh; dùng cho S1-S8, S11-S13. `restartWallet()`/`restartPayment()` dừng và dựng lại dịch vụ.
- **`child`:** hai tiến trình con thật, để thử `SIGKILL` (S9, S10 và vòng chẵn của soak `mixed`). Khác tiến trình nên **không có** lỗi
  dialect/publisher/`afterOrderHandled` (rule ở `sql.*`, `broker.publish.*` không bao giờ bắn; truyền `afterOrderHandled` bị từ chối ở
  mức kiểu và lúc chạy). Vẫn dùng được: proxy HTTP, `killSessions` (từ phía admin), `dropWalletBrokerConnections`, `crash*`/`restart*`.

### `heal()`: đưa hệ về trạng thái yên để oracle đọc

`system.heal({ timeoutMs?, allowUnsettledTopups? })`:

1. Tắt `plan` (**plan giữ trạng thái tắt sau heal**; muốn tiêm lỗi tiếp thì gọi `plan.enable()`), dựng lại dịch vụ nào đang dừng.
2. Chờ (`quiesce`, mặc định 90 giây; soak dùng 240 giây) tới khi: outbox không còn `PENDING`, queue (trừ `*.dlq`) rỗng, `webhook_events` và
   `charges` không còn `PENDING`, không còn topup `REQUESTED`, không còn lượt đối soát `RUNNING`, mọi order đã gửi đã được wallet xử lý
   **hoặc** nằm trong DLQ (message độc), và mọi kết quả `OrderPaidV1`/`OrderPaymentFailedV1` đã `SENT` đã tới Orders giả. Mặc định topup cũng
   phải rời `PENDING`; `allowUnsettledTopups: true` (S7, soak) cho phép topup treo `PENDING` vì chỉ đối soát sửa được.
3. Trong lúc chờ, harness **đẩy nhanh** những thứ production cố ý chờ lâu, qua kết nối quản trị (không đi qua dialect có lỗi): kéo dòng
   outbox `PENDING` đang backoff về "đến hạn" (backoff production 1/5/30/120/600 giây dài hơn timeout của heal); kéo retry/lease của topup
   `REQUESTED` về "đến hạn" (gửi lại luôn an toàn vì khóa idempotency cố định); đánh dấu `FAILED` các lượt đối soát `RUNNING` mồ côi của
   tiến trình wallet đã chết (nếu không chúng chỉ bị dọn sau 30 phút).
4. Cuối cùng ghi các order Orders giả đã nhận `OrderPaidV1` vào `expectations.ordersPaid` (cơ sở của INV-7). `expectations.topupsCreated`
   và `expectations.opsActionIds` được ghi ngay khi client nhận 2xx; kết quả lỗi/không rõ **không** được ghi (oracle không đòi thứ chưa được xác nhận).

## Kịch bản xác định (S1-S13)

Mỗi kịch bản: nạp ví bình thường, bật lỗi, thực hiện hành động, **chờ lỗi thực sự bắn** (`plan.fired(...)`; vì `heal()` tắt plan ngay),
`heal()`, kiểm đếm chính xác trong DB, rồi `assertSystemInvariants` một lần. Cấu hình harness: wallet gọi payment với timeout 3000 ms;
backoff nạp tiền và webhook `[1, 2, 3]` giây; `retryDelaysSeconds = [1, 2]` nên consumer cho tối đa 3 lần xử lý một message.

| Mã | Chế độ | Điểm lỗi | Kỳ vọng | Bất biến chủ chốt |
| -- | ------ | -------- | ------- | ----------------- |
| S1 | inproc | `sql.query.before`, lần khớp thứ 1 của `insert ... order_payments`: `KILL` mọi session wallet ngay trước khi ghi nợ | Ngay sau `KILL` chưa có khoản trả/bút toán, ví nguyên; order được giao lại và trả **đúng một lần** (hai lệnh insert, một bị giết); một dòng outbox `OrderPaidV1` | INV-1, 2, 4 |
| S2 | inproc | `sql.commit.after` trên **đúng kết nối** của transaction `PayOrder`: `KILL` rồi ném lỗi (consumer chết sau commit, trước ack) | Giao dịch đã commit trước khi bị giết; giao lại **cùng `eventId`** ra `DUPLICATE` (dòng inbox đã có); ví trừ một lần; một dòng outbox | INV-2, 4 |
| S2b | inproc | Sau khi đã trả, gửi lại **cùng `orderId` với `eventId` mới** | Kết quả `REPLAYED`: `OrderPaidV1` thứ hai (hai dòng outbox), cùng `walletTransactionId` và số tiền; ví vẫn chỉ trừ một lần | INV-2, 4 |
| S3 | inproc | Hook `afterOrderHandled` ném lỗi sau commit: (a) 2 lần (trong ngân sách retry), (b) 3 lần (hết lượt) | (a) Hội tụ ở lần xử lý thứ 3, không vào DLQ. (b) Message vào DLQ dù tiền đã trả đúng một lần: xem [ghi chú vận hành](chaos-findings.vi.md) | INV-2, 4 |
| S3c | inproc | Hook cắt mọi kết nối AMQP của wallet sau commit, trước ack (một lần) | Ack thất bại, broker giao lại thật (`redelivered`); lần giao lại là `DUPLICATE` (một dòng inbox); trả một lần; không vào DLQ | INV-2, 4 |
| S4 | inproc | `broker.publish.after` ném lỗi cho `OrderPaidV1` (publish xong, mất ack) | Relay gửi lại: Orders nhận hai bản **giống hệt** (cùng `messageId`), không mất; outbox cuối `SENT`, `attempts = 1` | INV-4 |
| S5 | inproc | Cắt kết nối AMQP của wallet hai lần (ở lần xử lý thứ 4 và thứ 8) khi đang xử lý 10 order | Cả 10 order trả đúng một lần, không mất, không vào DLQ; số lần xử lý > 10 (giao lại) | INV-2, 4 |
| S6a | inproc | Proxy wallet→payment: `503` ở lần tạo charge thứ 1, rồi trễ hơn timeout (charge **vẫn được tạo muộn**) ở lần thứ 2 | Đúng hai request tạo charge; một charge, một khóa idempotency; ví cộng đúng một lần | INV-3 |
| S6b | inproc | `503` rồi request bị `drop` trước khi payment nhận | Lúc `drop` payment chưa có charge; lần sau tạo được; một charge | INV-3 |
| S6c | inproc | `wallet-to-payment.response` ném lỗi **sau khi** payment đã tạo charge (webhook bị giữ) | Wallet gửi lại cùng khóa (replay), `charge_id` được ghi; vẫn một charge; ví cộng một lần sau khi thả webhook | INV-3 |
| S7 | inproc | `payment-to-wallet.request`: mọi webhook bị `drop` | `webhook_events` `FAILED` sau 4 lần gửi; charge `SUCCEEDED` nhưng topup `PENDING`, ví chưa tăng; oracle với `expectMissingAtWallet` buộc đối soát ghi bù **đúng một lần** (một giao dịch `TOPUP`) | INV-3, 5 |
| S8a | inproc | Mọi webhook bị `duplicate` | Cả hai bản đều được wallet trả 2xx; ghi có một lần; gửi lại thủ công cùng chữ ký ra `DUPLICATE` | INV-3 |
| S8b | inproc | Webhook bị giữ ~8 giây trong lúc đối soát thủ công ghi bù trước | Webhook muộn vẫn nhận 2xx, không ghi có lần hai, `DELIVERED` với `attempts = 1` (không vòng retry) | INV-3, 5 |
| S9 | **child** | `SIGKILL` wallet từ `wallet-to-payment.response` sau khi payment tạo charge nhưng trước khi wallet lưu `charge_id` | Sau khi dựng lại, wallet gửi lại **cùng khóa** (lease 60 giây được harness kéo về hạn); payment vẫn một charge/một khóa; topup `PENDING` rồi `SUCCEEDED`; ví cộng một lần | INV-3, 8 |
| S10 | **child** | Mọi webhook bị `drop`; `SIGKILL` payment sau khi charge `SUCCEEDED`, trước khi webhook giao | Payment dựng lại, webhook `DELIVERED` (số lần thử tăng); ví cộng một lần | INV-3, 8 |
| S11 | inproc | 11 ca: `adjust`/`reverse` x {lệnh ghi đầu, insert `ledger_entries`, insert `ops_actions`, sau commit} và `freeze` x {lệnh ghi đầu, insert `ops_actions`, sau commit}; `KILL` session wallet | Gửi lại **cùng `idempotencyKey`**: đúng một hiệu ứng thật và một dòng `ops_actions`; phản hồi lần gửi lại khớp kết quả đã lưu; không có audit mồ côi | INV-1, 6, 7 |
| S12 | inproc | Retention **thật** (`batchSize` 5): `KILL` ở lệnh `delete top` thứ hai của `outbox_sent` | Đúng 5 dòng bị xóa, bảng tài chính và số dư y nguyên, dòng còn trẻ không mất; lượt dọn kế tiếp (khởi động lại) xóa hết dòng đủ tuổi ở cả wallet và payment | INV-7 + bảng tài chính |
| S13 | inproc | `KILL` **mọi** session của wallet và payment khi hệ đang rảnh | Request kế tiếp tới mỗi dịch vụ thành công ngay lần đầu (đọc ví 200, nạp tiền 202): pool kiểm tra kết nối khi lấy nên session chết được thay thầm lặng; order vẫn trả được | INV-8, 1..4 |

Lệnh gây lỗi nào cũng được chứng minh là **thực sự xảy ra** (đếm `plan.fired`, kiểm tiền điều kiện ngay lúc lỗi, hoặc kiểm số request đi qua proxy)
và đã được thử bằng đột biến (cố ý làm kịch bản mất khả năng gây lỗi thì test phải thất bại).

## Bài soak ngẫu nhiên

`soak.ts` sinh tải và lịch lỗi từ seed; mỗi **vòng** dựng một hệ mới (2 tenant, mỗi tenant 4 khách có ví nạp sẵn):

- **Tải:** 8 luồng song song, mỗi luồng lặp: nạp tiền (qua HTTP), gửi order (qua broker), điều chỉnh, thử lại thao tác ops, đảo, đóng/mở băng, phát lại
  `OrderPaidV1`, đọc ví, đối soát thủ công, và (khi retention thật bật) làm "già" vài dòng để retention có việc.
- **Lỗi:** một luồng lịch lỗi, mỗi bước cách nhau 0,4-2,5 giây: rule `KILL` theo xác suất, `KILL` ngay, publish trùng/mất, cắt kết nối broker,
  proxy 5xx/chậm/drop, webhook drop/duplicate/5xx/chậm, và (`inproc`) khởi động lại wallet/payment hoặc (`child`) `SIGKILL` rồi dựng lại.
  Vòng `child` không có lỗi dialect/publisher (xem giới hạn).
- **Phán quyết** (`settleAndJudge`): hết giờ thì `heal({ allowUnsettledTopups: true })`, rồi đọc INV-3. Sạch thì oracle chặt hoàn toàn. Còn vi phạm thì
  chỉ được miễn khi có lỗi thuộc nhóm đường HTTP/dịch vụ ngừng **và** vi phạm được `MISSING_AT_WALLET` giải thích trọn vẹn (từng charge và tổng tiền); khi đó oracle
  chạy với `expectMissingAtWallet` (đối soát phải ghi bù đúng tập đó). Mọi trường hợp khác thì oracle chặt và ném đúng vi phạm.
- Mỗi vòng còn kiểm có lỗi thực sự bắn và (khi `CHAOS_MAX_SECONDS >= 20`) các loại tải chính (nạp tiền, order, điều chỉnh, đọc, đóng băng) mỗi loại thành công ít nhất một lần.
- Retention thật được bật cho khoảng 1/3 số vòng `inproc` (chọn theo seed). Vòng `child` không bật được: xem giới hạn.

### Tái hiện từ seed và nhật ký

Khi một vòng thất bại, test:

1. ghi `tests/chaos/.out/soak-<seed>-round<k>.json` (nhật ký thao tác: mọi `soak.op`, `soak.fault`, `fault`, `heal.*`, `crash`, `soak.failure` kèm lỗi, theo mốc thời gian) và in đường dẫn;
2. in lệnh chạy lại, dạng `CHAOS_SEED=<seed> CHAOS_ROUNDS=<k> corepack pnpm test:chaos:soak` (chạy lại các vòng 1..k vì mỗi vòng suy ra seed riêng từ seed gốc và số vòng).

Với `CHAOS_MODE`, `CHAOS_MAX_SECONDS` đã dùng, đặt lại đúng như lần thất bại. Kịch bản S1-S13 thất bại ghi `tests/chaos/.out/<tên-test-rút-gọn>-seed<seed>.json`. Thư mục `.out/` nằm trong `.gitignore`.

**Giới hạn trung thực của tái hiện:** cùng seed cho cùng **kế hoạch** (chuỗi lựa chọn thao tác của từng luồng và lịch lỗi theo thời gian; có meta-test
kiểm điều này). Phần **thực thi** thì không tất định: thứ tự đan xen giữa các luồng, thời điểm một request tới đích và kết quả của rule xác suất
(prng của `FaultPlan` bị tiêu thụ theo thứ tự các câu SQL thực tế) phụ thuộc lịch hệ điều hành và SQL Server. Chạy lại theo seed cho cùng kịch bản tải/lỗi
nhưng **không đảm bảo** cùng lỗi tái diễn; nhật ký ghi lại điều **đã** xảy ra, và là bằng chứng chính để phân tích. Một lần thất bại từng được kết luận chỉ từ nhật ký
(không tái hiện lại được cùng seed): xem [chaos-findings](chaos-findings.vi.md).

## Thêm điểm lỗi hoặc kịch bản mới

**Điểm lỗi.** Thường không cần sửa production. Dùng các điểm có sẵn: `sql.query.before|after`, `sql.begin.after`, `sql.commit.before|after`, `sql.rollback.before`
(lọc bằng `when: (info) => info.name === 'wallet' && info.sql.includes('...')`; nhớ `info.sql` đã chữ thường), `broker.publish.before|after`,
`wallet-to-payment.request|response`, `payment-to-wallet.request|response`, hook `afterOrderHandled`, và các thao tác trực tiếp `killSessions`,
`dropWalletBrokerConnections`, `crash*`/`restart*`. Muốn một loại lỗi mới: bọc ở `tests/chaos/support/` và gọi `plan.hit('<tên.điểm>', info)`; đừng thêm seam production nếu chưa
có lý do mạnh (ADR-0014 giới hạn ở hai seam). Kèm test của chính công cụ (`*.test.ts` nếu không cần Docker, `*.chaos.test.ts` nếu cần).

**Kịch bản.** Theo khuôn của `scenarios-sql-broker.chaos.test.ts`:

1. `beforeAll` dựng hệ (`createSystem`), `beforeEach` gọi `plan.clear()`, `afterAll` gọi `stop()`; một hook `afterEach` ghi nhật ký (`system.log.writeTo`) ra `tests/chaos/.out/` khi test thất bại.
2. Mỗi kịch bản dùng khách/order riêng; nạp ví **trước** khi bật lỗi (`heal()` tắt plan nên bật lại).
3. Thêm rule có `label`; thực hiện hành động; `waitFor` (từ `@billing/testing`) như `waitFor(() => plan.fired('<label>') >= n)`, **không** `sleep` cố định.
4. `heal()`, rồi khẳng định **đếm chính xác** trong DB (số `order_payments`, `charges`, dòng outbox...) và `assertSystemInvariants(system)` đúng một lần.
5. Chứng minh lỗi thật sự bắn: đặt `nth` quá lớn (rule không bao giờ bắn) thì kịch bản phải **thất bại**; làm hỏng kỳ vọng chính thì phải thất bại. Chạy hai lần liên tiếp để lộ chập chờn.
6. Cần `SIGKILL` thì dùng `createSystem({ mode: 'child' })`; cần lỗi dialect/publisher thì dùng `inproc`.

**Bất biến mới.** Thêm hàm kiểm ở `invariants.ts` với `code` ổn định, đặt vào `CHECKS` và thứ tự chuẩn trong `runInvariants`, rồi viết test âm trong `invariants.chaos.test.ts`
(làm hỏng trạng thái có hoàn tác và xác nhận oracle bắt đúng mã). **Loại tải/lỗi mới cho soak:** thêm vào `OP_WEIGHTS`/`FAULTS` trong `soak.ts`, giữ **số lần rút prng cố định** cho mỗi bước để kế hoạch vẫn ổn định theo seed.

## Giới hạn

- **Không phải test hạ tầng thật.** Lỗi được mô phỏng ở ranh giới ứng dụng: `KILL` session, đóng kết nối AMQP, proxy HTTP, `SIGKILL` tiến trình. Không thử mất mạng thật,
  đĩa đầy, failover SQL Server/RabbitMQ, đồng hồ lệch, hay quá tải tài nguyên (Toxiproxy hoặc dừng container đã bị loại: ADR-0014).
- **Không phủ phía Orders (C#).** "Orders" là một mô phỏng trong test (`OrdersSimulator`) chỉ ghi nhận sự kiện nhận được và không tự nối lại; hành vi khử trùng, xử lý lý do lạ
  của Orders thật nằm ngoài bộ này.
- **Chế độ `child` không có lỗi dialect/publisher**, nên S1-S5, S11, S12 và vòng `child` của soak (chỉ có `KILL` ngay, không có rule `KILL` giữa transaction) hẹp hơn vòng `inproc`.
- **Child không chạy được retention thật:** `loadConfig` thật của dịch vụ từ chối chu kỳ retention lẻ phút và số ngày < 7 cho khóa idempotency của payment, mà test cần chu kỳ ngắn và
  dữ liệu "đủ tuổi" trong vài giây. Retention thật chỉ nằm ở S12 và vòng `inproc` của soak.
- **Windows:** `SIGTERM` kết thúc ngay như `SIGKILL` (không có tắt êm), nên `stop()` của tiến trình con không thử được tắt êm; `SIGKILL` là `TerminateProcess`. Windows tái dùng pid rất nhanh,
  nên `stop()` không dò theo pid sau khi đã xác nhận tiến trình thoát. Chạy Linux/macOS chưa được đo trong tài liệu này.
- **Cổng cố định theo lần chạy:** mỗi hệ xin cổng trống lúc dựng và giữ nguyên qua restart; chạy hai lượt `test:chaos` song song trên cùng máy chưa được kiểm tra.
- **Oracle giả định retention tắt** trừ khi `retentionDeletes`: khi retention thật chạy, oracle chỉ nhìn các dòng còn lại và bỏ kiểm "order đã trả còn dòng outbox" (vì dòng `SENT` cũ có thể đã bị dọn).
- Lỗi mà bộ này tìm thấy được xử lý theo chính sách ở ADR-0014: lỗi nhỏ, rõ thì sửa ngay bằng commit riêng kèm test; lỗi lớn hoặc cần quyết định thiết kế thì ghi vào [chaos-findings](chaos-findings.vi.md).

## Test chập chờn và cách xử lý

- **Khởi động container:** `globalSetup` đôi khi lỗi khi chờ SQL Server ("Recovery is complete" trong log container), quan sát khoảng 2 trên 6 lần khởi động sau khi máy khởi động lại. Đây là lỗi
  hạ tầng của testcontainers, không phải của sản phẩm: chạy lại là đủ. Nếu lặp lại, kiểm tra Docker còn tài nguyên (bộ nhớ cho SQL Server) và container cũ chưa dọn.
- **Chờ theo điều kiện, không theo thời gian:** mọi chỗ chờ dùng `waitFor`/`quiesce` kèm timeout; thất bại `quiesce` nêu tên điều kiện chưa đạt. Một timeout của `heal()` thường là một
  tính chất hội tụ bị vỡ (ví dụ một topup `REQUESTED` không bao giờ được gửi lại), nên **đọc điều kiện chưa đạt trước khi tăng timeout**.
- **Đừng kết luận "chập chờn" khi soak thất bại.** Đọc `tests/chaos/.out/soak-<seed>-round<k>.json`, đối chiếu dòng thời gian với `fault`/`crash`/`heal.*`, chạy lại cùng seed vài lần; chỉ coi là lỗi
  của harness khi giải thích được bằng cơ chế cụ thể (như trường hợp trong [chaos-findings](chaos-findings.vi.md)), không phải vì "chạy lại thì qua".
- **Đếm hit của proxy** (`plan.hits`): lượt đối soát tự động 23h UTC của wallet cũng đi qua proxy wallet→payment; S6/S9 vì vậy chỉ đếm các request tạo charge bằng một rule đếm riêng.
- **Rule chạy nền:** worker nền (relay outbox, topup) cũng commit liên tục. Rule ở `sql.commit.after` phải gắn vào đúng `info.connection` của transaction cần thử (như S2), nếu không sẽ bắn nhầm vào commit của worker.
- Timeout mỗi test là 120 giây (hook 180 giây); kịch bản dài hơn đặt timeout riêng.
