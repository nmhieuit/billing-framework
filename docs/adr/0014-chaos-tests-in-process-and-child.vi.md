# ADR-0014: Chaos test chạy trong tiến trình và bằng tiến trình con, oracle bất biến dùng chung, lệnh riêng

**Trạng thái:** Chấp nhận — 2026-10-13

## Bối cảnh

Sau đối soát (ADR-0010), retention (ADR-0012) và công cụ vận hành (ADR-0013), các cam kết về tiền đã được viết ra và kiểm bằng test
từng thành phần, nhưng chưa ai kiểm chúng **cùng lúc, khi hạ tầng hỏng**: session SQL bị giết giữa transaction hoặc ngay sau commit, kết nối
RabbitMQ rớt trước ack, payment trả 5xx hay trễ quá timeout, webhook mất/trùng/muộn, dịch vụ bị `SIGKILL`. Chính những chỗ mà ADR-0007 (khử trùng nhiều
lớp), ADR-0009 (outbox ít nhất một lần) và ADR-0010 (đối soát ghi bù) dựa vào để đúng. Mục đích chính là **tìm lỗi thật**, không chỉ
thêm test; việc đó đòi một bộ gây lỗi đủ chính xác để nhắm vào từng điểm (giữa hai câu lệnh, sau commit, trước ack), một thước đo "đúng" duy nhất
áp lên mọi lần chạy, và chi phí chạy vừa phải.

## Quyết định

- **Lệnh riêng, không nằm trong `test:integration`.** `corepack pnpm test:chaos` (`vitest.chaos.config.ts`, tệp `*.chaos.test.ts`) dùng lại `globalSetup`
  testcontainers; bài soak dài là lệnh thứ hai `corepack pnpm test:chaos:soak` (`vitest.chaos-soak.config.ts`, tệp `*.soak.test.ts`). Cấu hình mặc định
  (`corepack pnpm test`) và `test:integration` loại các tệp này. Test thuần của công cụ (`*.test.ts`) vẫn chạy ở `corepack pnpm test`.
- **Hai chế độ chạy.** *Trong tiến trình* (mặc định): wallet và payment chạy ngay trong tiến trình test, nên chèn được lỗi vào dialect và publisher,
  nhanh và tất định. *Tiến trình con*: mỗi dịch vụ là một tiến trình Node thật (`main.ts`), crash bằng `SIGKILL` rồi dựng lại trên cùng DB và vhost; cấu hình đi qua biến môi trường
  (đúng một đối tượng cấu hình cho cả hai chế độ, đổi sang env bằng `service-config.ts`). Tiến trình con có một "lính gác" (`child-guard`) để không để lại tiến trình mồ côi khi cha chết.
- **Bọc dialect của Kysely thay cho plugin.** Seam production là `createDatabase(config, { wrapDialect })` và `StartOverrides.wrapDialect` (wallet, payment); thêm
  `StartOverrides.wrapPublisher` (wallet) cho relay outbox. Cả hai mặc định không làm gì.
- **Một oracle bất biến dùng chung, có test riêng.** `assertSystemInvariants` kiểm 8 bất biến (sổ cái, không ghi nợ hai lần, nạp tiền khớp payment, outbox, đối soát hội tụ, ops nguyên tử,
  dữ liệu đã xác nhận còn nguyên, phục hồi) bằng kết nối quản trị không bị can thiệp, theo thứ tự cố định để đối soát (có ghi bù) không che lỗi. Oracle có test âm riêng: cố ý làm hỏng
  trạng thái và đòi nó báo đúng mã vi phạm; oracle trên hệ rỗng hoặc khi truy vấn lỗi thì **ném**, không bao giờ "đạt" suông.
- **Kịch bản xác định cộng soak theo seed.** 13 kịch bản (S1-S13, kèm các biến thể S2b, S3c, S6a-c, S8a/b) nhắm từng điểm lỗi với khẳng định đếm chính xác và chứng minh lỗi thật sự
  bắn; một bài soak ngẫu nhiên tải/lỗi sinh từ seed (xen kẽ hai chế độ theo vòng) để lộ tổ hợp ta không nghĩ tới. Kết thúc mỗi kịch bản/vòng là `heal()` (tắt lỗi, dựng lại dịch vụ,
  chờ hội tụ theo điều kiện) rồi oracle.
- **Chính sách khi tìm thấy lỗi.** Lỗi nhỏ và rõ (dưới khoảng 50 dòng): sửa ngay bằng commit riêng kèm test tái hiện. Lỗi lớn hoặc cần quyết định thiết kế: ghi vào
  [chaos-findings](../ops/chaos-findings.vi.md), test tái hiện đánh dấu lỗi đã biết, hỏi người quyết định. Khi một lần chạy thất bại, ưu tiên nghi ngờ bộ công cụ **chỉ sau khi** giải thích
  được bằng cơ chế cụ thể (đã xảy ra: xem chaos-findings); không gọi là "chập chờn" để bỏ qua.

## Phương án đã loại

- **Toxiproxy hoặc công cụ gây lỗi mạng ngoài:** thêm một container và một cổng điều khiển, chỉ cắt được ở tầng TCP; không nhắm được "sau commit, trước ack" hay "lệnh insert thứ hai
  của transaction", là các điểm mà cam kết thật sự phụ thuộc vào. Proxy HTTP tự viết đã đủ cho đường wallet↔payment (trả 5xx, trễ, mất, nhân đôi, mất phản hồi).
- **Pause/stop container SQL Server hoặc RabbitMQ:** mỗi lượt chạy chỉ có một container mỗi loại, dùng chung cho mọi tệp test, nên dừng nó làm hỏng các tệp khác và làm kết quả phụ thuộc thời gian.
  `KILL` đúng session của database test và đóng đúng kết nối AMQP của user wallet cho cùng loại lỗi mà không động tới ai khác.
- **Gộp vào `test:integration`:** chaos chậm (cỡ vài phút đến mười phút), cố ý làm hỏng và có phần ngẫu nhiên; trộn vào sẽ làm vòng phản hồi hằng ngày chậm và khiến thất bại khó phân loại.
- **Kysely plugin để chèn lỗi:** `transformQuery` của plugin là hàm **đồng bộ**, không `await` được, nên không chờ được `KILL` hay độ trễ trước khi lệnh chạy; và plugin **không thấy `begin`/`commit`/`rollback`**
  (chúng đi qua driver chứ không qua pipeline truy vấn), nên không đặt được lỗi "ngay sau commit". Bọc `Dialect`/`Driver` thấy từng lần lấy kết nối, `begin`, `commit`, `rollback` và
  chờ được bất đồng bộ. Bản thiết kế đầu (`dbPlugins`) vì vậy đã đổi sang `wrapDialect`.
- **Chỉ có tiến trình con (hoặc chỉ trong tiến trình):** chỉ tiến trình con thì không chèn được lỗi dialect/publisher (khác tiến trình) và chậm; chỉ trong tiến trình thì không thử được crash thật.
  Hai chế độ bù nhau, và soak xen kẽ cả hai.
- **Soak thuần ngẫu nhiên, không có kịch bản xác định:** tìm được lỗi lạ nhưng không chứng minh được từng cam kết đã được thử, và thất bại khó đọc. Kịch bản xác định là nền, soak là lưới phụ.

## Hệ quả

- **Hai seam production chỉ dùng cho test:** `wrapDialect` (qua `createDatabase`, bootstrap wallet và payment) và `wrapPublisher` (bootstrap wallet), mặc định bỏ trống và không đổi hành vi.
  Seam của `createDatabase` có unit test; bootstrap chỉ truyền `{ wrapDialect }` khi có, và bộ chaos chính là test của chúng ở chế độ trong tiến trình. Thêm seam thứ ba cần lý do
  mạnh, và phải giữ "mặc định không làm gì".
- **Thời gian CI riêng:** `test:chaos` chạy vài phút đến cỡ mười phút (nhiều kịch bản, hai chế độ, một vòng soak ngắn), `test:chaos:soak` tùy chỉnh được; cần chạy như một bước riêng.
- **Cần Docker** (testcontainers cho SQL Server và RabbitMQ). Không dùng stack `billing-local`; khởi động container đôi khi chập chờn (chạy lại).
- **Tái hiện chỉ ở mức kế hoạch.** Cùng seed cho cùng kế hoạch tải/lỗi nhưng thứ tự đan xen thực thi không tất định, nên một lỗi hiếm có thể không tái diễn; bằng chứng chính là nhật ký thao tác
  (`tests/chaos/.out/`). Điều này đã được chấp nhận thay vì cố làm toàn bộ hệ tất định.
- **Giới hạn phạm vi được nói rõ:** không phải test hạ tầng thật, không phủ phía Orders (C#), tiến trình con không có lỗi dialect/publisher và không chạy được retention thật, Windows không có
  tắt êm (`SIGTERM` giống `SIGKILL`). Chi tiết và cách thêm kịch bản: [chaos-testing](../ops/chaos-testing.vi.md).
- **Kết quả đầu tiên:** bộ này chưa phát hiện lỗi sản phẩm nào; các lỗi nó tìm thấy là của chính bộ công cụ (oracle đọc lệch pha, `heal` chưa chờ đủ) và đã sửa; một vài hành vi cần người vận hành biết
  được ghi thành ghi chú vận hành trong [chaos-findings](../ops/chaos-findings.vi.md). Thiết kế: [spec 6d](../superpowers/specs/2026-10-12-chaos-tests-design.md).
