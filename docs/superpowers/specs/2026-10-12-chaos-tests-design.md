# Bước 6d — Chaos test tự động: thiết kế

**Ngày:** 2026-10-12
**Trạng thái:** Bản thiết kế, chờ duyệt
**Phạm vi:** Bộ kiểm thử gây lỗi có chủ đích (SQL Server, RabbitMQ, payment/webhook, crash service) cho wallet và payment, với oracle bất biến dùng chung, 13 kịch bản xác định và một bài soak ngẫu nhiên có seed. Là vòng bốn của Bước 6. Dựa trên sổ cái kép (ADR-0002), khử trùng/idempotency (ADR-0007), outbox và topology (ADR-0009), đối soát (ADR-0010), retention (ADR-0012) và công cụ ops (ADR-0013). Mục đích chính là **tìm lỗi thật** trong các cam kết đã hứa, không chỉ thêm test.

## 1. Quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Cách gây lỗi | Trong tiến trình + `KILL` session SQL + đóng kết nối RabbitMQ; crash thật bằng tiến trình con + `SIGKILL`. Không Toxiproxy, không pause/stop container dùng chung |
| 2 | Nơi chạy | Lệnh riêng `corepack pnpm test:chaos` (cấu hình `vitest.chaos.config.ts`, tệp `*.chaos.test.ts`), không nằm trong `test:integration`; dùng lại `globalSetup` testcontainers |
| 3 | Kiểu kịch bản | 13 kịch bản xác định + một bài soak ngẫu nhiên theo seed |
| 4 | Phạm vi lỗi | SQL Server (mất kết nối giữa/sau transaction), RabbitMQ (mất kết nối, consumer chết, giao lại, publish trùng), payment/webhook (5xx, chậm, mất, trùng, muộn), crash/khởi động lại service |
| 5 | Khi tìm ra lỗi | Lỗi nhỏ và rõ (dưới khoảng 50 dòng): sửa ngay bằng commit riêng kèm test tái hiện. Lỗi lớn hoặc cần quyết định thiết kế: ghi vào `docs/ops/chaos-findings.vi.md`, test tái hiện đánh dấu lỗi đã biết, báo người dùng quyết định |
| 6 | Thay đổi code production | Chỉ hai seam dùng cho test, mặc định không làm gì: `StartOverrides.dbPlugins` (wallet và payment) và `StartOverrides.wrapPublisher` (wallet), cộng sửa các lỗi chaos tìm ra |

## 2. Bộ công cụ gây lỗi (`tests/chaos/support/`)

Không thuộc code production; chỉ test dùng.

- **`FaultPlan`:** danh sách quy tắc `{điểm, lần thứ n | xác suất theo seed, hành động}`; mỗi lần kích hoạt được ghi vào nhật ký lỗi (thời điểm, điểm, hành động) để tái hiện và để thông báo khi thất bại.
- **`sql-faults`:**
  - `killSessions(config)` chạy `KILL` trên mọi session của đúng database test (trừ session đang gọi); không chạm database khác.
  - Một Kysely plugin (qua `dbPlugins`) chặn lệnh thứ n khớp một mẫu và gọi `killSessions` ngay trước khi lệnh chạy (lỗi giữa transaction, transaction bị rollback), hoặc ngay sau khi lệnh `commit` hoàn tất (lỗi sau commit, trước ack).
- **`broker-faults`:** dùng `TestBroker.closeConnections` hiện có; `wrapPublisher` bọc `EventPublisher` để (a) publish xong rồi trả lỗi (mất xác nhận → giao trùng) hoặc (b) trả lỗi mà không publish; hook consumer chết trước/sau ack (mở rộng `afterOrderHandled`).
- **`payment-faults`:** một proxy HTTP nhỏ đặt giữa wallet và payment (cả hai hướng: tạo charge và gửi webhook) có thể trả 5xx, làm chậm, treo, làm mất hoặc nhân đôi một request theo kịch bản; không cần sửa code production.
- **`crash`:** chạy wallet/payment như tiến trình con (`tsx services/<tên>/src/main.ts`) với cấu hình qua biến môi trường, cổng tự do, `SIGKILL` rồi khởi động lại trên cùng DB và vhost. Kịch bản không cần crash dùng service trong tiến trình (nhanh hơn).
- **`system-harness`:** dựng một hệ hoàn chỉnh (hai tenant, wallet, payment, broker, "Orders giả" ghi nhận mọi sự kiện nhận được và có thể gửi `OrderReadyForPaymentV1`), ở chế độ trong tiến trình hoặc tiến trình con.
- **`quiesce`:** chờ theo điều kiện (không `sleep` cố định, có timeout) tới khi outbox, queue và hàng đợi webhook rỗng và mọi topup ở trạng thái cuối.
- **`prng`:** bộ sinh số giả ngẫu nhiên theo seed.
- **`op-log`:** nhật ký thao tác dạng JSON dòng.

## 3. Bất biến (`assertSystemInvariants`)

Chạy sau giai đoạn chữa lành (tắt lỗi → `quiesce`).

1. **Sổ cái:** tổng số dư mọi tài khoản bằng 0; số dư mỗi tài khoản bằng tổng các dòng của nó; mỗi giao dịch cân bằng.
2. **Không ghi nợ hai lần:** mỗi `orderId` có tối đa một giao dịch `ORDER_PAYMENT` và một dòng `order_payments`. Mọi `OrderPaidV1` của cùng order mang cùng `walletTransactionId` và số tiền.
3. **Nạp tiền khớp payment:** mỗi topup `SUCCEEDED` có đúng một giao dịch `TOPUP`; tổng `TOPUP` trong sổ cái bằng tổng charge hoàn tất bên payment; mỗi idempotency key tạo tối đa một charge.
4. **Outbox ít nhất một lần:** mọi kết quả `PayOrder` đã commit có sự kiện tương ứng đến được "Orders giả"; không có sự kiện cho order chưa có giao dịch tương ứng.
5. **Đối soát sau chữa lành:** chạy đối soát cho ngày chứa dữ liệu thì không còn dòng `OPEN` loại `LEDGER_UNBALANCED` hoặc `BALANCE_MISMATCH`; các `MISSING_AT_WALLET` được ghi bù; chạy lại sau ghi bù cho 0 lệch.
6. **Ops nguyên tử:** mỗi dòng `ops_actions` có đúng hiệu ứng tương ứng và ngược lại; thử lại cùng khóa idempotency sau lỗi cho cùng kết quả.
7. **Retention an toàn:** chạy retention chế độ xóa thật giữa lúc có lỗi thì các bất biến 1–3 vẫn đúng.
8. **Phục hồi:** sau lỗi, service vẫn phục vụ (health 200) và pool kết nối dùng lại được sau khi bị `KILL`.

Oracle có test riêng (mục 6): cố ý làm hỏng trạng thái và xác nhận hàm bắt được.

## 4. Kịch bản xác định (`scenarios.chaos.test.ts`)

Mỗi kịch bản: dựng hệ, gây một điểm lỗi cụ thể, chữa lành, gọi `assertSystemInvariants` và kiểm thêm kết quả riêng.

- **S1:** KILL SQL giữa `PayOrder`, trước commit → không ghi nợ; giao lại thì trả đúng một lần.
- **S2:** KILL SQL ngay sau commit `PayOrder`, trước ack → giao lại ra `REPLAYED`, ví chỉ bị trừ một lần, outbox đủ.
- **S3:** consumer chết trước ack, giao lại nhiều lần → hội tụ về một khoản trả.
- **S4:** mất kết nối broker khi relay outbox vừa publish xong, chưa `markSent` → `OrderPaidV1` giao trùng cùng `eventId`, không mất.
- **S5:** mất kết nối broker khi đang consume → client tự nối lại và xử lý tiếp, không mất message.
- **S6:** payment trả 5xx hoặc timeout khi tạo charge → topup được thử lại, tối đa một charge, cuối cùng thành công.
- **S7:** webhook thất lạc → đối soát ghi có đúng một lần.
- **S8:** webhook trùng, và webhook đến muộn sau khi đối soát đã ghi bù → không ghi có lần hai.
- **S9:** `SIGKILL` wallet khi đang submit topup → khởi động lại, submit lại cùng khóa, vẫn một charge.
- **S10:** `SIGKILL` payment sau khi tạo charge, trước webhook → sau khởi động lại webhook vẫn được gửi và chỉ có hiệu lực một lần.
- **S11:** KILL giữa `AdjustWallet`, `ReverseTransaction` và freeze → không có audit mồ côi; thử lại cùng khóa cho cùng kết quả.
- **S12:** retention thật bị cắt kết nối giữa lô → không xóa dòng sống; lượt sau hoàn tất.
- **S13:** KILL toàn bộ session khi service rảnh → request kế tiếp vẫn xử lý được.

## 5. Bài soak ngẫu nhiên (`soak.chaos.test.ts`)

- Seed từ `CHAOS_SEED` (mặc định chọn ngẫu nhiên và luôn in ra); `CHAOS_ROUNDS` (mặc định 3) và `CHAOS_MAX_SECONDS` (mặc định khoảng 30 giây mỗi vòng) chỉnh độ dài.
- Mỗi vòng dùng 2 tenant và vài chục khách có ví nạp sẵn; chạy khoảng 8 luồng tải song song: nạp tiền qua HTTP, `OrderReadyForPaymentV1` qua broker, ops (điều chỉnh, đảo, đóng/mở băng, phát lại), retention, và thao tác đối soát.
- Lịch lỗi sinh từ seed gồm: KILL SQL, đóng kết nối broker, publish trùng/mất, payment 5xx/chậm, webhook mất/trùng/trễ, `SIGKILL` rồi khởi động lại wallet hoặc payment.
- Hết thời gian thì tắt lỗi, `quiesce`, `assertSystemInvariants`.
- Khi thất bại ghi seed, nhật ký lỗi và nhật ký thao tác vào `tests/chaos/.out/` (không commit). Chạy lại cùng seed cho cùng chuỗi thao tác và cùng lịch lỗi; thứ tự đan xen giữa các luồng song song vẫn có thể khác, nên tái hiện không đảm bảo tuyệt đối.

## 6. Kiểm thử cho chính công cụ

- Unit/integration cho `prng`, `FaultPlan` (xác định theo seed), `killSessions` (chỉ ảnh hưởng database test), plugin chặn lệnh thứ n, proxy HTTP (5xx, mất, nhân đôi), `quiesce` (hết hạn thì báo rõ điều kiện chưa đạt).
- **Test oracle:** cho từng bất biến, cố ý làm hỏng trạng thái (giao dịch trùng, số dư lệch, outbox thiếu, ops_actions mồ côi, charge trùng) và xác nhận `assertSystemInvariants` ném lỗi nêu đúng bất biến vi phạm.
- Hai seam production có unit test: khi không truyền `dbPlugins`/`wrapPublisher` thì hành vi không đổi.

## 7. Tài liệu

`docs/ops/chaos-testing.vi.md` (cách chạy `test:chaos`, biến môi trường, đọc nhật ký lỗi, tái hiện seed, thêm điểm lỗi hoặc kịch bản, giới hạn), ADR-0014 (phương pháp: trong tiến trình + tiến trình con, oracle bất biến, lệnh riêng), cập nhật README; `docs/ops/chaos-findings.vi.md` nếu có phát hiện lớn chưa sửa.

## 8. Rủi ro và ngoài phạm vi

- Test chập chờn do thời gian: mọi chỗ chờ theo điều kiện; mục tiêu bộ mặc định dưới khoảng 10 phút.
- SQL Server dùng chung: `KILL` chỉ nhắm session của database test; không dừng container.
- Tiến trình con cần cổng tự do, cấu hình qua biến môi trường và dọn tiến trình khi test kết thúc hoặc thất bại.
- Có thể lộ lỗi thật của các vòng trước (ví dụ pool kết nối không phục hồi sau `KILL`, nhánh `REPLAYED` phát `eventId` mới); xử lý theo chính sách ở mục 1 (#5).
- Ngoài phạm vi: Toxiproxy hoặc lỗi mức hạ tầng thật, phía Orders (C#), đo hiệu năng (thuộc 6e).
