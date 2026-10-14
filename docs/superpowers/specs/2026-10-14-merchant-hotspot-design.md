# Bước 6e — Điểm nóng MERCHANT: thiết kế (Pha A: bộ đo và baseline)

**Ngày:** 2026-10-14
**Trạng thái:** Pha A đã triển khai (bộ đo `tests/perf`, baseline và phân tích: [`docs/perf/merchant-hotspot.vi.md`](../../perf/merchant-hotspot.vi.md)); chờ người dùng chốt ngưỡng trước Pha B
**Phạm vi:** Bước cuối của Bước 6 (vận hành). Chia hai pha. **Pha A (spec này):** bộ đo tải tái lập được, chạy đo trần hiện tại và commit baseline; dừng để người dùng chốt ngưỡng. **Pha B (chu kỳ riêng sau Pha A):** vá điểm nóng nếu số đo cho thấy cần, với spec và kế hoạch ngắn riêng dựa trên số liệu thật. Dựa trên sổ cái kép (ADR-0002), trả order (`2026-10-10-order-payment-integration-design.md`), công cụ ops (ADR-0013) và bộ chaos (ADR-0014).

## 1. Bối cảnh và giả thuyết

Mọi lần trả order ghi nợ ví khách và ghi có `system:MERCHANT:<cur>`. `PayOrder` gọi `accounts.lockMany([walletId, merchantId])`; `lockMany` khóa (UPDLOCK) từng tài khoản theo id sắp xếp tăng dần. Vì `system:MERCHANT:…` đứng trước `wallet:…` theo thứ tự chữ cái, dòng MERCHANT là dòng được khóa **đầu tiên** và được giữ cho tới hết transaction (inbox, ledger, `order_payments`, outbox, commit). Cùng một dòng này bị khóa bởi đảo giao dịch `ORDER_PAYMENT`; dòng `system:GATEWAY:<cur>` có hình dạng tương tự với nạp tiền; `system:ADJUSTMENT:<cur>` với điều chỉnh.

Giả thuyết (chưa kiểm chứng, Pha A sẽ trả lời bằng số đo):
- H1: thông lượng trả order bị chặn trên bởi thời gian giữ khóa dòng MERCHANT, và thứ tự khóa hiện tại (MERCHANT trước) kéo dài thời gian giữ.
- H2: ngay cả khi khóa MERCHANT muộn hơn, mỗi dòng `ledger_entries` của MERCHANT có khóa ngoại tới `accounts`, nên việc kiểm khóa ngoại có thể vẫn xếp hàng trên dòng MERCHANT đang bị khóa.
- H3: ở nhiều luồng, tranh chấp biểu hiện thành `LCK_M_*` tăng và độ trễ đuôi (p99) tăng nhanh hơn thông lượng.

## 2. Quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Mục tiêu | Đo trần hiện tại trước; người dùng chốt ngưỡng hành động sau khi xem số liệu |
| 2 | Mức được vá (Pha B) | Bậc 1 không đổi dữ liệu (đổi thứ tự khóa toàn hệ thống: ví khách trước, tài khoản hệ thống sau; khóa MERCHANT muộn nhất có thể; thu ngắn đoạn giữ khóa). Bậc 2 (chia nhỏ số dư MERCHANT thành nhiều dòng con) chỉ làm khi số đo cho thấy bậc 1 chưa đủ **và** người dùng duyệt lại |
| 3 | Mức đo | Mức use case trên SQL Server thật (testcontainers) + một lần đo đầu-cuối qua harness chaos (không gây lỗi) |
| 4 | Lưu kết quả | Lệnh riêng `corepack pnpm test:perf`; báo cáo JSON + Markdown và baseline commit trong `docs/perf/`; không dùng làm cổng CI |
| 5 | Kiểm đúng đắn | Sau mỗi lượt đo chạy `assertSystemInvariants`; số dư hoặc sổ cái sai thì kết quả đo không hợp lệ. **Lệch khi triển khai:** ở mức use case, mỗi lượt được kiểm bằng `tests/perf/support/validity.ts` (sổ cái cân, số dư khớp dòng sổ cái, hiệu số đếm giao dịch khớp số thao tác thành công) thay vì `assertSystemInvariants`, vì oracle đầy đủ cần payment, broker và đối soát; phần đầu-cuối vẫn chạy oracle đầy đủ |
| 6 | Pha A không đổi code production | Chỉ thêm `tests/perf/**`, script, tài liệu |

## 3. Bộ đo (`tests/perf/`)

- **`support/load-driver.ts`:** vòng tải kín với N luồng đồng thời cố định (mỗi luồng gửi thanh toán kế tiếp khi cái trước hoàn tất); chạy theo thời gian hoặc theo số lượng; ghi độ trễ từng thao tác; đếm riêng lỗi, deadlock (mã 1205) và timeout.
- **`support/histogram.ts`:** p50/p95/p99 chính xác từ mẫu thô.
- **`support/wait-stats.ts`:** chụp và lấy hiệu `sys.dm_os_wait_stats` (nhóm `LCK_M_%`) và đếm request bị chặn (`sys.dm_exec_requests`) trước/sau lượt đo. Bộ đo chạy một mình trên instance SQL Server của testcontainers (`fileParallelism: false`), nên số liệu instance-wide quy được về tải của bộ đo.
- **`support/seed.ts`:** dựng tenant, khách, ví và nạp tiền bằng đúng use case của hệ thống (`CreateWallet`, rồi `AdjustWallet` CREDIT), để dữ liệu đầu vào hợp lệ với oracle.
- **`support/report.ts`:** ghi JSON theo lược đồ cố định (có phiên bản lược đồ) và sinh bảng Markdown từ JSON.
- **Kịch bản (`tests/perf/scenarios/*.perf.test.ts`):**
  1. *Trả order:* gọi trực tiếp `PayOrder` (khách khác nhau, order khác nhau) — điểm nóng MERCHANT.
  2. *Nạp tiền:* áp kết quả nạp thành công (`ApplyPaymentResult`) — điểm nóng GATEWAY.
  3. *Hỗn hợp:* trả order có xen đảo giao dịch (`ReverseTransaction`) và điều chỉnh.
  4. *Đầu-cuối:* dùng `createSystem()` của harness chaos (không gây lỗi): Orders giả gửi `OrderReadyForPaymentV1`, đo thông lượng từ lúc gửi đến lúc nhận `OrderPaidV1`, đối chiếu với số đo mức use case.
- Tham số qua biến môi trường: `PERF_CONCURRENCY` (mặc định `1,4,16,64`), `PERF_DURATION_SECONDS` (mặc định 20 mỗi mức), `PERF_REPEATS` (mặc định 3), `PERF_CUSTOMERS` (mặc định 2000), `PERF_OUT` (thư mục xuất).

## 4. Xử lý nhiễu và tái lập

- Mỗi mức đồng thời có khởi động nóng (bỏ vài giây hoặc N giao dịch đầu), lặp `PERF_REPEATS` lần; báo trung vị cùng min/max. Thứ tự các mức cố định.
- Báo cáo ghi thông tin máy (số CPU, RAM, phiên bản Node và SQL Server, git sha) và một nhãn máy (`PERF_MACHINE`, mặc định tên host). Chỉ so sánh số đo cùng nhãn máy.
- Cảnh báo (không chặn) khi tải nền của máy cao trước khi đo.

## 5. Tự kiểm bộ đo

- Unit: histogram (số mẫu biết trước → phân vị đúng), hiệu wait-stats, ghi báo cáo (lược đồ), driver vòng kín với tác vụ giả (số luồng đồng thời không vượt N; kết thúc đúng điều kiện).
- **Test "kênh quan sát" (canary):** giữ khóa dòng MERCHANT từ một kết nối riêng trong X ms; bộ đo phải thấy thông lượng giảm và `LCK_M_*` tăng theo đúng chiều. Chứng minh bộ đo nhìn thấy được tranh chấp khóa.
- Smoke tích hợp: 2 giây, 2 luồng; oracle đạt, báo cáo đúng lược đồ, mọi giao dịch đo được đều thành công.

## 6. Sản phẩm bàn giao của Pha A

- `docs/perf/merchant-hotspot.vi.md`: phương pháp, cách chạy, cách đọc kết quả, bảng baseline (thông lượng và p50/p95/p99 theo mức đồng thời cho từng kịch bản), phân tích điểm nóng và nhận định H1–H3 đúng hay sai theo số đo.
- JSON baseline commit trong `docs/perf/`.
- Cập nhật README (mục "Đo hiệu năng").
- **Điểm dừng:** kết thúc Pha A bằng báo cáo số liệu gửi người dùng để chốt ngưỡng. Không tự bắt đầu Pha B.

## 7. Ngoài phạm vi của Pha A

Thay đổi code production, cổng CI, tối ưu, đo kiểu mở (tốc độ đến cố định), đo trên phần cứng giống production. Đo kiểu mở ở mức mục tiêu để xác nhận ngưỡng thuộc Pha B nếu cần.

## 8. Rủi ro

- Số đo nhiễu trên máy dev (Windows, Docker Desktop): giảm bằng khởi động nóng, lặp lại, báo trung vị và ghi nhãn máy; không rút kết luận từ chênh lệch nhỏ.
- `sys.dm_os_wait_stats` là thống kê của cả instance: chỉ hợp lệ khi không có tải khác chạy cùng lúc; tài liệu ghi rõ và bộ đo cảnh báo nếu phát hiện tải nền.
- Seed bằng use case thật làm bước chuẩn bị chậm khi `PERF_CUSTOMERS` lớn: chấp nhận được, thời gian chuẩn bị không tính vào số đo.
