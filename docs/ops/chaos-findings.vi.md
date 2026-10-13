# Kết quả chaos test

Tài liệu ghi các phát hiện và ghi chú vận hành rút ra từ bộ chaos test (`tests/chaos`). Mỗi lỗi thật chưa sửa sẽ có một mục riêng (hiện chưa có lỗi thật nào). Cách chạy bộ test: [chaos-testing](chaos-testing.vi.md); quyết định: [ADR-0014](../adr/0014-chaos-tests-in-process-and-child.vi.md).

## Phát hiện

**Bộ chaos test không phát hiện lỗi sản phẩm nào**, kể cả lỗi đã được sửa: nhánh `feature/chaos-tests` không thay đổi hành vi của wallet, payment hay các package dùng chung ngoài hai seam test-only (`wrapDialect`, `wrapPublisher`; thêm vài hàm hỗ trợ trong `services/wallet/src/test-support-orders.ts`), và không có test `it.fails` nào đánh dấu "lỗi đã biết". Các cam kết về tiền (ghi nợ một lần, nạp tiền một lần, outbox ít nhất một lần, thao tác ops nguyên tử, retention không chạm dữ liệu tài chính, pool phục hồi sau `KILL`) đều đứng vững trước 13 kịch bản xác định và các lần soak đã chạy. Hai hành vi cần người vận hành biết được ghi ở mục "Ghi chú vận hành" bên dưới; chúng là hệ quả của thiết kế, không phải lỗi.

Thứ bộ này bắt được là lỗi của **chính bộ công cụ** (harness và oracle), vì oracle bắt đầu phản ứng với trạng thái lệch pha mà sản phẩm không hề gây ra. Liệt kê để người thêm kịch bản tránh lặp lại:

- Kịch bản S2 ban đầu bắn vào commit đầu tiên sau lệnh insert `order_payments`; các worker nền (relay, topup) cũng commit liên tục nên có lúc rule bắn nhầm vào commit của worker và order không bao giờ được giao lại (1 lần trong khoảng 4 lượt chạy cả tệp). Rule nay gắn vào đúng `info.connection` của transaction trả order (commit `61bc5cd`).
- `stop()` của chế độ child báo "tiến trình còn sống" oan khi Windows cấp lại pid của một tiến trình con đã thoát cho tiến trình khác (commit `1ecf5ee`).
- S6 và S9 đếm `plan.hits` thô nên bị lượt đối soát tự động 23h UTC của wallet (cũng đi qua proxy) làm lệch số đếm; nay chỉ đếm request tạo charge (commit `e075f0c`).
- Soak seed 100476504 (xem cuối tài liệu): `heal()` chưa chờ hết topup `REQUESTED`, và oracle đọc phía wallet bằng nhiều truy vấn rời nhau (commit `c0afc40`, cùng `c2496da`).

## Ghi chú vận hành

Đây là ghi chú vận hành, **không phải lỗi**.

### Đơn ĐÃ trả vẫn có thể rơi vào DLQ của `wallet.order-payments` (kịch bản S3)

- Hiện tượng: nếu consumer thất bại SAU khi `PayOrder` đã commit (ví dụ lỗi trước ack, mất kết nối, móc xử lý ném lỗi) đủ số lần vượt `retryDelaysSeconds` (mặc định cấu hình harness `[1, 2]` = tối đa 3 lần xử lý), message bị chuyển vào DLQ `wallet.order-payments.dlq` dù khoản trả đã ghi từ lần đầu. Các lần giao lại đều ra `DUPLICATE` (dòng inbox `processed_messages` đã có) nên không ghi nợ lần hai.
- Tác động: cảnh báo DLQ có thể kêu cho đơn mà tiền đã trừ đúng một lần; `OrderPaidV1` vẫn nằm trong outbox và được relay gửi như bình thường.
- Cách xử lý: trước khi làm gì với message trong DLQ, kiểm tra `order_payments` (và `processed_messages`) của tenant theo `orderId`/`eventId`. Nếu đã có khoản trả thì không cần can thiệp tiền.
- Phát lại từ DLQ là vô hại: message cùng `eventId` sẽ ra `DUPLICATE`, không ghi nợ lại.
- Tái hiện: `tests/chaos/scenarios-sql-broker.chaos.test.ts`, test "S3: consumer dies before ack three times (retries exhausted)".

### Webhook hết lượt gửi thì topup treo `PENDING` tới lần đối soát kế tiếp (kịch bản S7, S9)

Đây là ghi chú vận hành, **không phải lỗi**.

- Hiện tượng: payment gửi webhook theo `WEBHOOK_BACKOFF`, mặc định production `1,5,30,120,600` giây (xem `services/payment/.env.example` và `services/payment/src/config.ts`) = 6 lần gửi trong khoảng 756 giây (~12,6 phút). Sau lần thất bại cuối, sự kiện chuyển `FAILED` và được giữ lại để điều tra, payment không gửi nữa. Nếu wallet chết, hoặc đường payment → wallet hỏng, lâu hơn khoảng đó thì charge đã `SUCCEEDED` nhưng topup của wallet vẫn `PENDING` (ví chưa được ghi có).
- Tác động: tiền khách đã bị thu nhưng ví chưa tăng cho tới lần đối soát tự động kế tiếp (chạy một lần mỗi ngày, tối đa khoảng một ngày), trừ khi vận hành viên chạy đối soát thủ công. Cảnh báo `billing-topups-stuck` sẽ kêu khi topup chờ quá ngưỡng.
- Cách xử lý: chạy đối soát thủ công `POST /reconciliations` (ngày chứa charge); với `RECONCILE_AUTOFIX` bật, đối soát ghi bù đúng một lần (`MISSING_AT_WALLET` thành `AUTO_APPLIED`). Các bước chi tiết: [reconciliation-runbook](../integration/reconciliation-runbook.vi.md).
- Cửa sổ lease 60 giây (theo thiết kế, không cần can thiệp): sau khi wallet chết giữa lúc gửi sang payment, topup chỉ được gửi lại khi lease 60 giây của lần chiếm trước hết hạn; sau khi payment chết giữa lúc gửi webhook, sự kiện chỉ đến hạn gửi lại khi lease 60 giây hết. Gửi lại dùng cùng khóa idempotency nên payment không tạo charge thứ hai.
- Tái hiện: `tests/chaos/scenarios-payment-crash.chaos.test.ts`, test S7 (mất toàn bộ webhook, đối soát ghi bù đúng một lần) và S9 (SIGKILL wallet, gửi lại cùng khóa).

## Kết quả bài soak ngẫu nhiên

Hai phần: `tests/chaos/soak.chaos.test.ts` (nằm trong `corepack pnpm test:chaos`: meta-test và một vòng inproc ~15 giây với seed cố định mặc định 1, hoặc `CHAOS_SEED`) và bài dài `tests/chaos/soak-long.soak.test.ts` chạy riêng bằng `corepack pnpm test:chaos:soak` (seed ngẫu nhiên nếu không đặt `CHAOS_SEED`, mặc định 3 vòng x 30 giây, trộn inproc/child; `vitest.chaos-soak.config.ts` đã bật in console (`silent: false`) nên thấy dòng `chaos seed=<n> rounds=<m> mode=<mode>`). Biến môi trường: `CHAOS_SEED`, `CHAOS_ROUNDS`, `CHAOS_MAX_SECONDS` (mỗi vòng), `CHAOS_MODE` (`inproc` | `child` | `mixed`). Khi thất bại, nhật ký ghi ở `tests/chaos/.out/soak-<seed>-round<k>.json` kèm lệnh chạy lại.

- Chưa phát hiện lỗi sản phẩm nào qua các seed 1-5 và hai lần chạy seed ngẫu nhiên đã thử (3813232944 và 100476504, xem bên dưới); không có mục `it.fails`. Thời lượng đã đo: 3 vòng x 30 giây `mixed` mất 2m40s-3m54s; 4 vòng x 60 giây mất 7m15s-7m52s. Một lần, vòng 60 giây chấp nhận 3 trạng thái `MISSING_AT_WALLET` (đối soát ghi bù đúng một lần).
- Cùng seed cho cùng KẾ HOẠCH tải và lịch lỗi, không cho cùng đan xen thực thi nên một lỗi hiếm có thể không tái hiện đúng; nhật ký thao tác ghi lại điều đã xảy ra.
- Vòng `child` không bật được retention thật: cấu hình thật của dịch vụ từ chối chu kỳ lẻ phút và số ngày < 7 cho khóa idempotency của payment; retention thật chỉ nằm ở vòng `inproc` (và kịch bản S12).
- Sau soak, topup treo `PENDING` do webhook hết lượt chỉ được miễn khi có lỗi đường HTTP/dịch vụ ngừng giải thích được, oracle thấy đúng trạng thái MISSING_AT_WALLET, VÀ webhook của charge đó không ở trạng thái `DELIVERED` (nếu wallet đã trả 2xx mà không ghi có thì luôn là lỗi); đối soát phải ghi bù đúng một lần.
- Một lần thất bại của soak (seed 100476504, vòng 2, child) hóa ra là lỗi của harness, không phải của sản phẩm: một topup còn `REQUESTED` với lần retry nằm trong tương lai (payment bị SIGKILL nên hai lần gửi đầu thất bại, backoff 1/2/3 giây) hoàn tất NGAY SAU khi `heal({ allowUnsettledTopups })` trả về, đúng lúc oracle đang đọc. `heal` bỏ qua cả điều kiện topup nên không chờ nó, và oracle đọc charge → topup → sổ cái bằng ba truy vấn rời nhau nên thấy ghi có sổ cái mà topup còn `PENDING`. Sản phẩm vẫn nguyên tử (`ApplyPaymentResult` ghi inbox, topup và sổ cái trong một transaction). Đã sửa: `heal` luôn chờ hết topup `REQUESTED` (và đẩy nhanh retry), oracle đọc phía wallet trong một snapshot và đọc wallet trước payment. Đây **không** phải lỗi sản phẩm. Nó cũng không phải một lượt đối soát `RUNNING`: giả thuyết đó được thử trước (và `heal` vẫn chờ các lượt `RUNNING` như một lớp phòng thủ thêm), nhưng nguyên nhân gốc là topup `REQUESTED` ở trên cùng phép đọc lệch pha của oracle. Kết luận được suy ra từ nhật ký thao tác (`tests/chaos/.out/soak-100476504-round2.json`); chạy lại cùng seed (cùng kế hoạch, khác đan xen) không tái hiện được lỗi, và các lần chạy lại `CHAOS_SEED=100476504 CHAOS_ROUNDS=2` sau đó đều đạt.