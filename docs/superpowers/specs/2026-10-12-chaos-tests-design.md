# Bước 6d — Chaos test tự động: thiết kế

**Ngày:** 2026-10-12
**Trạng thái:** Đã triển khai (2026-10-13). Mục "Khác biệt so với thiết kế" ở cuối ghi những chỗ mã khác bản thiết kế ban đầu
**Phạm vi:** Bộ kiểm thử gây lỗi có chủ đích (SQL Server, RabbitMQ, payment/webhook, crash service) cho wallet và payment, với oracle bất biến dùng chung, 13 kịch bản xác định và một bài soak ngẫu nhiên có seed. Là vòng bốn của Bước 6. Dựa trên sổ cái kép (ADR-0002), khử trùng/idempotency (ADR-0007), outbox và topology (ADR-0009), đối soát (ADR-0010), retention (ADR-0012) và công cụ ops (ADR-0013). Mục đích chính là **tìm lỗi thật** trong các cam kết đã hứa, không chỉ thêm test.

## 1. Quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Cách gây lỗi | Trong tiến trình + `KILL` session SQL + đóng kết nối RabbitMQ; crash thật bằng tiến trình con + `SIGKILL`. Không Toxiproxy, không pause/stop container dùng chung |
| 2 | Nơi chạy | Lệnh riêng `corepack pnpm test:chaos` (cấu hình `vitest.chaos.config.ts`, tệp `*.chaos.test.ts`), không nằm trong `test:integration`; dùng lại `globalSetup` testcontainers |
| 3 | Kiểu kịch bản | 13 kịch bản xác định + một bài soak ngẫu nhiên theo seed |
| 4 | Phạm vi lỗi | SQL Server (mất kết nối giữa/sau transaction), RabbitMQ (mất kết nối, consumer chết, giao lại, publish trùng), payment/webhook (5xx, chậm, mất, trùng, muộn), crash/khởi động lại service |
| 5 | Khi tìm ra lỗi | Lỗi nhỏ và rõ (dưới khoảng 50 dòng): sửa ngay bằng commit riêng kèm test tái hiện. Lỗi lớn hoặc cần quyết định thiết kế: ghi vào `docs/ops/chaos-findings.vi.md`, test tái hiện đánh dấu lỗi đã biết, báo người dùng quyết định |
| 6 | Thay đổi code production | Chỉ hai seam dùng cho test, mặc định không làm gì: `StartOverrides.wrapDialect` (wallet và payment, đi qua `createDatabase(config, { wrapDialect })`) và `StartOverrides.wrapPublisher` (wallet), cộng sửa các lỗi chaos tìm ra (rốt cuộc không có lỗi sản phẩm nào cần sửa) |

## 2. Bộ công cụ gây lỗi (`tests/chaos/support/`)

Không thuộc code production; chỉ test dùng.

- **`FaultPlan`:** danh sách quy tắc `{điểm, lần thứ n | xác suất theo seed, hành động}`; mỗi lần kích hoạt được ghi vào nhật ký lỗi (thời điểm, điểm, hành động) để tái hiện và để thông báo khi thất bại.
- **`sql-faults`:**
  - `killSessions(config)` chạy `KILL` trên mọi session của đúng database test (trừ session đang gọi); không chạm database khác.
  - Một dialect bọc (`faultyDialect`, qua `wrapDialect`) gọi `plan.hit` ở `sql.query.before`/`sql.query.after`, `sql.begin.after`, `sql.commit.before`/`sql.commit.after` và `sql.rollback.before`; rule chọn lệnh thứ n khớp một mẫu SQL rồi gọi `killSessions` ngay trước khi lệnh chạy (lỗi giữa transaction, transaction bị rollback), hoặc ngay sau khi `commit` hoàn tất (lỗi sau commit, trước ack).
- **`broker-faults`:** `dropBrokerConnections` dùng `TestBroker.closeConnections` hiện có (chỉ đóng kết nối của user wallet); `faultyPublisher` (qua `wrapPublisher`) bọc `EventPublisher` để (a) publish xong rồi trả lỗi (`broker.publish.after`: mất xác nhận → giao trùng) hoặc (b) trả lỗi mà không publish (`broker.publish.before`); consumer chết sau commit, trước ack dùng hook `afterOrderHandled` có sẵn.
- **`http-fault-proxy` (`HttpFaultProxy`):** một proxy HTTP nhỏ đặt giữa wallet và payment (cả hai hướng: tạo charge và gửi webhook) có thể trả 5xx, làm chậm, treo, làm mất hoặc nhân đôi một request theo kịch bản; không cần sửa code production.
- **`crash`:** chạy wallet/payment như tiến trình con (`node --import child-guard.mjs --import tsx services/<tên>/src/main.ts`) với cấu hình qua biến môi trường (`service-config.ts`), cổng tự do, `SIGKILL` rồi khởi động lại trên cùng DB và vhost. Kịch bản không cần crash dùng service trong tiến trình (nhanh hơn).
- **`system-harness`:** dựng một hệ hoàn chỉnh (hai tenant, wallet, payment, broker, "Orders giả" ghi nhận mọi sự kiện nhận được và có thể gửi `OrderReadyForPaymentV1`), ở chế độ trong tiến trình hoặc tiến trình con.
- **`quiesce`:** chờ theo điều kiện (không `sleep` cố định, có timeout) tới khi outbox, queue và hàng đợi webhook rỗng và mọi topup ở trạng thái cuối.
- **`prng`:** bộ sinh số giả ngẫu nhiên theo seed.
- **`op-log`:** nhật ký thao tác có mốc thời gian, ghi ra một tệp JSON (mảng các mục).

## 3. Bất biến (`assertSystemInvariants`)

Chạy sau giai đoạn chữa lành (`heal()`: tắt lỗi → dựng lại dịch vụ chết → `quiesce`). Thứ tự kiểm tra là bắt buộc vì đối soát có ghi bù (autofix) và có thể che lỗi: (1) INV-1, 2, 4 chặt; (2) INV-3 **trước** đối soát (rỗng, trừ khi `expectMissingAtWallet` cho phép đúng các trạng thái `MISSING_AT_WALLET` mà đối soát sẽ ghi bù); (3) INV-8; (4) chỉ khi các bước trên sạch: INV-5 (đối soát thật, rồi lượt thứ hai kiểm hội tụ) và **kiểm lại INV-1..4 chặt**; (5) INV-6, INV-7. Chi tiết: [chaos-testing](../../ops/chaos-testing.vi.md).

1. **Sổ cái:** tổng số dư mọi tài khoản bằng 0; số dư mỗi tài khoản bằng tổng các dòng của nó; mỗi giao dịch cân bằng.
2. **Không ghi nợ hai lần:** mỗi `orderId` có tối đa một giao dịch `ORDER_PAYMENT` và một dòng `order_payments`. Mọi `OrderPaidV1` của cùng order mang cùng `walletTransactionId` và số tiền.
3. **Nạp tiền khớp payment:** mỗi topup `SUCCEEDED` có đúng một giao dịch `TOPUP`; tổng `TOPUP` trong sổ cái bằng tổng charge hoàn tất bên payment; mỗi idempotency key tạo tối đa một charge.
4. **Outbox ít nhất một lần:** mọi kết quả `PayOrder` đã commit có sự kiện tương ứng đến được "Orders giả"; không có sự kiện cho order chưa có giao dịch tương ứng.
5. **Đối soát sau chữa lành:** chạy đối soát cho ngày chứa dữ liệu thì không còn dòng `OPEN` loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH`; các `MISSING_AT_WALLET` được ghi bù; chạy lại sau ghi bù cho 0 lệch.
6. **Ops nguyên tử:** mỗi dòng `ops_actions` có đúng hiệu ứng tương ứng và ngược lại; thử lại cùng khóa idempotency sau lỗi cho cùng kết quả.
7. **Retention an toàn:** chạy retention chế độ xóa thật giữa lúc có lỗi thì các bất biến 1–3 vẫn đúng. (Cài đặt: oracle đối chiếu `System.expectations`, tức mọi thứ client đã nhận xác nhận thành công, gồm order Orders đã nhận `OrderPaidV1`, `topupId` và `actionId` ops đã trả, vẫn còn dòng tương ứng; khi retention xóa thật các kiểm tra khác chỉ nhìn các dòng còn lại.)
8. **Phục hồi:** sau lỗi, service vẫn phục vụ (health 200) và pool kết nối dùng lại được sau khi bị `KILL`.

Oracle có test riêng (mục 6): cố ý làm hỏng trạng thái và xác nhận hàm bắt được.

## 4. Kịch bản xác định (`scenarios-sql-broker`, `scenarios-payment-crash`, `scenarios-ops-retention`, mỗi tệp `*.chaos.test.ts`)

Mỗi kịch bản: dựng hệ, gây một điểm lỗi cụ thể, chữa lành, gọi `assertSystemInvariants` và kiểm thêm kết quả riêng. Bảng kịch bản đầy đủ (điểm lỗi, kỳ vọng, bất biến): [chaos-testing](../../ops/chaos-testing.vi.md).

- **S1:** KILL SQL giữa `PayOrder`, trước commit → không ghi nợ; giao lại thì trả đúng một lần.
- **S2:** KILL SQL ngay sau commit `PayOrder`, trước ack (kèm lỗi giả sau commit để consumer thấy thất bại) → giao lại CÙNG `eventId` ra `DUPLICATE` (dòng inbox đã commit), ví chỉ bị trừ một lần, outbox đủ. Nhánh `REPLAYED` (cùng `orderId`, `eventId` MỚI) có kịch bản riêng S2b: phát `OrderPaidV1` thứ hai với `eventId` mới, cùng `walletTransactionId`, ví vẫn chỉ bị trừ một lần.
- **S3:** consumer chết trước ack, giao lại nhiều lần → hội tụ về một khoản trả. S3 (móc ném lỗi) đi qua đường retry-exchange; S3c cắt kết nối AMQP từ móc sau commit để ack thất bại và broker giao lại thật (`redelivered=true`), kết quả `DUPLICATE`, không vào DLQ.
- **S4:** mất kết nối broker khi relay outbox vừa publish xong, chưa `markSent` → `OrderPaidV1` giao trùng cùng `eventId`, không mất.
- **S5:** mất kết nối broker khi đang consume → client tự nối lại và xử lý tiếp, không mất message.
- **S6:** payment trả 5xx hoặc timeout khi tạo charge → topup được thử lại, tối đa một charge, cuối cùng thành công. Ba biến thể: S6a (503 rồi trễ quá timeout, charge vẫn được tạo muộn), S6b (503 rồi request bị mất trước khi payment nhận), S6c (payment tạo charge nhưng phản hồi bị mất, wallet gửi lại cùng khóa).
- **S7:** webhook thất lạc → đối soát ghi có đúng một lần.
- **S8:** webhook trùng (S8a) và webhook đến muộn sau khi đối soát đã ghi bù (S8b) → không ghi có lần hai.
- **S9:** `SIGKILL` wallet khi đang submit topup → khởi động lại, submit lại cùng khóa, vẫn một charge.
- **S10:** `SIGKILL` payment sau khi tạo charge, trước webhook → sau khởi động lại webhook vẫn được gửi và chỉ có hiệu lực một lần.
- **S11:** KILL giữa `AdjustWallet`, `ReverseTransaction` và freeze → không có audit mồ côi; thử lại cùng khóa cho cùng kết quả.
- **S12:** retention thật bị cắt kết nối giữa lô → không xóa dòng sống; lượt sau hoàn tất.
- **S13:** KILL toàn bộ session khi service rảnh → request kế tiếp vẫn xử lý được.

## 5. Bài soak ngẫu nhiên (`soak.chaos.test.ts` và `soak-long.soak.test.ts`)

- Seed từ `CHAOS_SEED` (mặc định chọn ngẫu nhiên và luôn in ra); `CHAOS_ROUNDS` (mặc định 3) và `CHAOS_MAX_SECONDS` (mặc định 30 giây mỗi vòng) chỉnh độ dài; `CHAOS_MODE` (`inproc` | `child` | `mixed`, mặc định `mixed`: vòng lẻ chạy trong tiến trình, vòng chẵn chạy tiến trình con).
- Bài dài chạy riêng bằng `corepack pnpm test:chaos:soak`; `test:chaos` chỉ gồm meta-test của bộ máy soak và một vòng ngắn (15 giây, `inproc`) với seed cố định mặc định 1.
- Mỗi vòng dùng 2 tenant và vài chục khách có ví nạp sẵn; chạy khoảng 8 luồng tải song song: nạp tiền qua HTTP, `OrderReadyForPaymentV1` qua broker, ops (điều chỉnh, đảo, đóng/mở băng, phát lại), retention, và thao tác đối soát.
- Lịch lỗi sinh từ seed gồm: KILL SQL, đóng kết nối broker, publish trùng/mất, payment 5xx/chậm, webhook mất/trùng/trễ, `SIGKILL` rồi khởi động lại wallet hoặc payment.
- Hết thời gian thì tắt lỗi, `heal()` (cho phép topup chưa chốt), rồi oracle: chặt hoàn toàn nếu INV-3 sạch; chỉ miễn khi vi phạm là `MISSING_AT_WALLET` giải thích trọn vẹn bởi lỗi đường HTTP/dịch vụ ngừng (khi đó đối soát phải ghi bù đúng tập đó).
- Khi thất bại ghi nhật ký thao tác (kèm seed, vòng, lỗi) vào `tests/chaos/.out/soak-<seed>-round<k>.json` (không commit) và in lệnh chạy lại. Chạy lại cùng seed cho cùng chuỗi thao tác và cùng lịch lỗi; thứ tự đan xen giữa các luồng song song vẫn có thể khác, nên tái hiện không đảm bảo tuyệt đối.

## 6. Kiểm thử cho chính công cụ

- Unit/integration cho `prng`, `FaultPlan` (xác định theo seed), `killSessions` (chỉ ảnh hưởng database test), dialect bọc (rule theo lệnh thứ n), proxy HTTP (5xx, mất, nhân đôi), `quiesce` (hết hạn thì báo rõ điều kiện chưa đạt).
- **Test oracle:** cho từng bất biến, cố ý làm hỏng trạng thái (giao dịch trùng, số dư lệch, outbox thiếu, ops_actions mồ côi, charge trùng) và xác nhận `assertSystemInvariants` ném lỗi nêu đúng bất biến vi phạm.
- Seam production: `createDatabase` có unit test (`connection.test.ts`): không truyền `wrapDialect` thì không gọi gì và hành vi không đổi. Bootstrap của wallet và payment chỉ truyền `{ wrapDialect }` khi được cấp; hai seam ở bootstrap được phủ bởi chính bộ chaos (chế độ trong tiến trình), không có unit test riêng.

## 7. Tài liệu

[`docs/ops/chaos-testing.vi.md`](../../ops/chaos-testing.vi.md) (cách chạy `test:chaos` và `test:chaos:soak`, biến môi trường, đọc nhật ký lỗi, tái hiện seed, thêm điểm lỗi hoặc kịch bản, giới hạn), [ADR-0014](../../adr/0014-chaos-tests-in-process-and-child.vi.md) (phương pháp: trong tiến trình + tiến trình con, oracle bất biến, lệnh riêng), cập nhật README; [`docs/ops/chaos-findings.vi.md`](../../ops/chaos-findings.vi.md) ghi phát hiện và ghi chú vận hành (hiện không có lỗi sản phẩm nào chưa sửa).

## 8. Rủi ro và ngoài phạm vi

- Test chập chờn do thời gian: mọi chỗ chờ theo điều kiện; mục tiêu bộ mặc định dưới khoảng 10 phút.
- SQL Server dùng chung: `KILL` chỉ nhắm session của database test; không dừng container.
- Tiến trình con cần cổng tự do, cấu hình qua biến môi trường và dọn tiến trình khi test kết thúc hoặc thất bại.
- Có thể lộ lỗi thật của các vòng trước (ví dụ pool kết nối không phục hồi sau `KILL`, nhánh `REPLAYED` phát `eventId` mới); xử lý theo chính sách ở mục 1 (#5).
- Ngoài phạm vi: Toxiproxy hoặc lỗi mức hạ tầng thật, phía Orders (C#), đo hiệu năng (thuộc 6e).

## 9. Khác biệt so với thiết kế

Những chỗ mã khác bản thiết kế ban đầu (mã là nguồn đúng):

- **`wrapDialect` thay cho `dbPlugins`.** Plugin Kysely không `await` được (`transformQuery` đồng bộ) và không thấy `commit`, nên seam là `createDatabase(config, { wrapDialect })` và `StartOverrides.wrapDialect` (wallet, payment). `StartOverrides.wrapPublisher` (wallet) đúng như thiết kế. Hook `afterOrderHandled` đã có sẵn, không phải seam mới.
- **Mã nguồn công cụ:** `payment-faults` thành `http-fault-proxy.ts` (`HttpFaultProxy`, hai proxy `wallet-to-payment`/`payment-to-wallet`); thêm `service-config.ts` (một cấu hình cho cả hai chế độ) và `child-guard.mjs` (chống tiến trình mồ côi). Tiến trình con chạy `node --import ... --import tsx main.ts`, pid chính là dịch vụ. Nhật ký thao tác là một tệp JSON (mảng), không phải JSON dòng.
- **Kịch bản nằm ở ba tệp** (`scenarios-sql-broker`, `scenarios-payment-crash`, `scenarios-ops-retention`), không phải một tệp `scenarios.chaos.test.ts`. Biến thể thêm: S2b, S3 (hai nhánh: trong ngân sách retry và hết lượt vào DLQ), S3c, S6a-c, S8a/b.
- **S2 ra `DUPLICATE`, không phải `REPLAYED`.** Giao lại cùng `eventId` sau commit gặp dòng inbox nên là `DUPLICATE`; `REPLAYED` (cùng `orderId`, `eventId` mới) có kịch bản riêng S2b. S3c cắt kết nối AMQP thật để có giao lại `redelivered=true`.
- **Chế độ chạy.** S9 và S10 chạy tiến trình con; mọi kịch bản khác chạy trong tiến trình (cần lỗi dialect/publisher). Tiến trình con không có lỗi dialect/publisher và không chạy được retention thật (cấu hình thật từ chối chu kỳ không phải số phút nguyên và số ngày giữ < 7 cho khóa idempotency của wallet và payment và cho `processed_messages` của wallet).
- **Oracle:** thứ tự kiểm tra có đối soát (xem mục 3), `expectMissingAtWallet` chỉ miễn đúng `MISSING_AT_WALLET` và không bao giờ miễn khi webhook của charge đã `DELIVERED`, phần đọc phía wallet của INV-3 trong một snapshot, mã vi phạm ổn định. INV-7 cài đặt là "mọi thứ đã xác nhận còn nguyên", không phải chạy lại INV-1..3 riêng khi retention xóa thật (các bất biến ấy vẫn chạy bình thường trên hệ có retention thật).
- **Soak:** tách làm hai. `soak.chaos.test.ts` nằm trong `test:chaos` (meta-test và một vòng `inproc` 15 giây, seed cố định 1 hoặc `CHAOS_SEED`); bài dài `soak-long.soak.test.ts` chạy bằng `corepack pnpm test:chaos:soak` (`vitest.chaos-soak.config.ts`) với seed ngẫu nhiên, 3 vòng x 30 giây và `CHAOS_MODE=mixed` (vòng lẻ `inproc`, vòng chẵn `child`). Biến `CHAOS_MODE` là bổ sung so với thiết kế. Lý do tách: `test:chaos` còn dư thời gian dưới mục tiêu khoảng 10 phút.
- **Thời lượng:** `test:chaos` gồm 143 test đo được 9m40s-9m50s khi bài soak 3 vòng còn nằm trong đó, sát mục tiêu; đó là lý do tách.
- **Chính sách lỗi tìm thấy:** bộ này không phát hiện lỗi sản phẩm nào; các lỗi tìm ra là của chính harness/oracle và đã sửa (xem [chaos-findings](../../ops/chaos-findings.vi.md)). Hai ghi chú vận hành rút ra (DLQ có thể chứa order đã trả, webhook hết lượt thì topup treo tới lần đối soát kế tiếp) không phải lỗi.
