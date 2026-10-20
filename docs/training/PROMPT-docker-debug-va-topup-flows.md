# Prompt: debug wallet + payment cùng lúc trên Docker, và draw.io 3 luồng nạp tiền

> Cách dùng: mở phiên Claude Code ở gốc repo, gõ `/engineering:documentation` (phần 2 có thể dùng `/engineering:system-design`), rồi dán nguyên phần "PROMPT" bên dưới.
> Agent phải hỏi bạn các câu ở Giai đoạn 0 **trước khi** sửa file hay vẽ.

---

## PROMPT

### Vai trò
Bạn là kỹ sư Node.js/TypeScript senior kiêm người viết tài liệu kỹ thuật, quen VS Code debugger, Docker Compose và draw.io (diagrams.net).
Người đọc: software manager, có kinh nghiệm .NET (ASP.NET Core, EF Core, RabbitMQ, MassTransit), **mới học Node.js**, đang học theo `docs/training/nodejs-1-tuan/`. Máy Windows, VS Code, Docker Desktop. Tiếng Việt; thuật ngữ giữ tiếng Anh kèm giải thích tiếng Việt.

### Hai yêu cầu
1. **Chỉnh `.vscode/launch.json`** để debug **wallet và payment cùng lúc trong Docker container**.
2. **Thêm một file draw.io nhiều sheet** (`docs/training/nodejs-1-tuan/diagrams/topup-flows.drawio`):
   - Sheet 1: luồng nạp tiền (top-up) **happy case**.
   - Sheet 2: luồng nạp tiền **bị trùng**.
   - Sheet 3: luồng nạp tiền khi **payment phản hồi chậm**, kích hoạt **retry** và **circuit breaker**.

### Quy tắc bắt buộc: HỎI LẠI, KHÔNG SUY DIỄN
- Điều gì chưa chắc hoặc chưa được xác nhận: **dừng và hỏi** (AskUserQuestion, tối đa 4 câu mỗi lần, có phương án gợi ý). Không tự chọn thay người học.
- Mọi khẳng định về code kèm **`file:dòng` đã mở đọc thật**. Khi in số dòng, **chỉ dùng `cat -n` cho MỘT file mỗi lệnh** (nhiều file trong một lệnh làm số dòng cộng dồn và sai, đã từng xảy ra trong repo này).
- Hành vi runtime (thứ tự, retry, timeout, trùng lặp) phải **chạy thử bằng code thật** của repo (kiểu các lab ở `docs/training/nodejs-1-tuan/labs/`) trước khi vẽ. Cái gì không chạy được (cần Docker, VS Code, SQL Server) ghi **[CHƯA CHẠY]**; cái gì suy luận ghi **[GIẢ THUYẾT]**, ngay trên sơ đồ và trong tài liệu.
- Không sửa code nghiệp vụ trong `services/` và `packages/`. Phạm vi sửa chỉ gồm: `.vscode/*`, `deploy/compose.debug.yml` (nếu thật cần), `docs/training/**`.
- Không commit hoặc push khi chưa được phép trong phiên. Khi được phép: tạo **nhánh mới từ `main`**, commit, push nhánh đó; **không** mở PR nếu chưa được yêu cầu.
- Trước khi bàn giao phải chạy `corepack pnpm typecheck`, `lint`, `format:check` và báo kết quả. Lưu ý: ở thời điểm viết prompt này `format:check` đang **đỏ vì `.vscode/launch.json`** chưa đúng định dạng Prettier; mọi chỉnh sửa file này phải để nó qua `prettier --check`.

### Trạng thái hiện tại của repo (đã kiểm chứng, phải đọc lại để xác nhận, không chép nguyên)
- `.vscode/launch.json` đã có: các cấu hình launch cục bộ `Debug wallet-service (envFile)`, `Debug payment-service (envFile)` và compound `Wallet + Payment (envFile)` (chạy local, hạ tầng trong Docker); và hai cấu hình **attach** `Attach wallet (Docker)` (cổng 9229), `Attach payment (Docker)` (cổng 9230). **Chưa có compound** cho hai cấu hình attach.
- `deploy/compose.debug.yml` đã có: chạy `node --inspect=0.0.0.0:9229 --import tsx ...` cho wallet và payment, publish `127.0.0.1:9229` (wallet) và `127.0.0.1:9230` (payment).
- Hướng dẫn nền: `docs/training/nodejs-1-tuan/ngay-3-huong-dan-debug-topup.md` (mục 4 là Docker). Điều **chưa kiểm chứng** ở đó: việc gộp `-f deploy/compose.debug.yml` lên các service được `include` trong `deploy/compose.local.yml`; việc breakpoint ánh xạ đúng qua `remoteRoot: /app`.
- Luồng nạp tiền: `POST /topups` (wallet) → `RequestTopup` (`request-topup.ts`) → `submitSoon` chạy nền → `SubmitTopup` → `HttpPaymentGateway.createCharge` → payment `POST /charges` → worker payment hoàn tất charge và gửi webhook → wallet `POST /webhooks/payment` → `ApplyPaymentResult`.
- **Circuit breaker: tìm `grep -riE "circuit|breaker"` trên mã nguồn và tài liệu không thấy gì.** Repo có timeout (`AbortSignal.timeout`, `PAYMENT_TIMEOUT_MS` mặc định 5000, `http-payment-gateway.ts`), retry theo bậc backoff (`TOPUP_SUBMIT_BACKOFF=1,5,30,120,600`, `Topup.recordUnavailable`), nhưng không có circuit breaker.
- Wallet **không** gửi `x-correlation-id` và **không** gửi `X-Simulate` sang payment (`http-payment-gateway.ts`); payment chỉ chạy kịch bản `X-Simulate` (`fail`, `delay`, `webhook=drop|duplicate`, `response=timeout`) khi client gọi trực tiếp vào payment (`domain/scenario.ts`, `interface/http/charges.route.ts`).
- Đã có sơ đồ mẫu cùng phong cách: `docs/training/nodejs-1-tuan/diagrams/runtime-request-sequence.drawio` (sequence diagram, màu theo lớp kiến trúc, legend, chú thích từng component, bảng số mũi tên → hàm → `file:dòng`).

### Giai đoạn 0: Khảo sát và HỎI (làm trước, chưa sửa, chưa vẽ)
1. Đọc: `.vscode/launch.json`, `deploy/compose.debug.yml`, `deploy/compose.local.yml`, `deploy/compose.services.yml`, `docs/training/nodejs-1-tuan/ngay-3-huong-dan-debug-topup.md`, các file topup ở wallet (`request-topup.ts`, `inline-topup-submitter.ts`, `submit-topup.ts`, `apply-payment-result.ts`, `domain/topup.ts`, `http-payment-gateway.ts`, `topups.controller.ts`, `webhooks.controller.ts`) và payment (`create-charge.ts`, `charges.route.ts`, `domain/scenario.ts`, `complete-due-charges.ts`, `deliver-due-webhooks.ts`, `http-webhook-sender.ts`), cùng `docs/ops/chaos-testing.vi.md` và các kịch bản chaos liên quan HTTP chậm. Ghi lại các file đã đọc.
2. Xác minh bằng lệnh: `grep -riE "circuit|breaker"` (xác nhận không có), và danh sách cấu hình hiện có trong `launch.json`.
3. **Hỏi người học** (bắt buộc; chưa trả lời thì chưa làm):

   **Về yêu cầu 1 (launch.json):**
   - Chỉ cần thêm **compound** `Attach wallet + payment (Docker)` (F5 một lần gắn vào cả hai container), hay cần thêm cả **`tasks.json`** với `preLaunchTask` tự chạy `docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env up -d wallet payment` và chờ cổng inspector sẵn sàng?
   - Giữ `tsx watch` (tự nạp lại khi sửa code, nhưng có thể làm breakpoint mất) hay `node --inspect` như `compose.debug.yml` hiện tại (ổn định hơn, phải `restart` container sau khi sửa)?
   - Có muốn sửa **định dạng Prettier của toàn bộ `.vscode/launch.json`** (hiện `format:check` đỏ vì file này) trong cùng thay đổi không?
   - Có nên đóng gói luôn bước kiểm tra `docker compose ... config` để xác nhận việc gộp file `-f` với `include` không?

   **Về yêu cầu 2 (draw.io):**
   - **Sheet 2, "bị trùng" là trùng nào?** Các khả năng có thật trong code (người học chọn một hoặc nhiều):
     a. Client gửi lại `POST /topups` với **cùng Idempotency-Key** (wallet trả lại kết quả cũ, không gửi lại sang payment; `request-topup.ts`).
     b. **Hai request đồng thời** cùng key (một bên vấp khóa chính, thử lại một lần, thấy bản ghi của bên thắng; `request-topup.ts`).
     c. Wallet gửi lại `POST /charges` sang payment với **cùng idempotency key** `topup:<tenant>:<topupId>` (payment trả lại bản cũ; `create-charge.ts`).
     d. **Webhook bị giao hai lần** (`webhook=duplicate` hoặc payment gửi lại; wallet trả `DUPLICATE`; `apply-payment-result.ts`).
     e. Cùng key nhưng **nội dung khác** (`IdempotencyConflictError`).
   - **Sheet 3, circuit breaker:** repo **không có** circuit breaker. Chọn một phương án:
     A. Chỉ vẽ cơ chế **có thật**: timeout `PAYMENT_TIMEOUT_MS`, kết quả `unavailable`, `recordUnavailable` với backoff, Worker thử lại, hết bậc thì `FAILED` (`PAYMENT_UNAVAILABLE`), webhook thành công đến muộn vẫn được nhận, đối soát tự ghi bù. Ghi rõ trên sheet: "Không có circuit breaker trong code".
     B. Phương án A **cộng một lớp "đề xuất (chưa tồn tại)"** vẽ khác màu và gắn nhãn rõ: circuit breaker ba trạng thái (closed, open, half-open) đặt ở `HttpPaymentGateway`, kèm tham số đề xuất và hệ quả. Không được trình bày như thể đã có trong code.
     C. Không vẽ circuit breaker.
   - **Cách tạo tình huống "payment chậm" khi debug:** wallet không gửi `X-Simulate`, nên không dùng được kịch bản `delay`/`response=timeout` qua wallet. Hỏi người học chọn cách minh họa: (i) `docker compose ... pause payment` (kết nối treo, hết `PAYMENT_TIMEOUT_MS`), (ii) breakpoint tạm dừng lâu trong payment, (iii) lab với `HttpPaymentGateway` thật + `fetchImpl` chậm, (iv) chaos test hiện có, (v) chỉ vẽ lý thuyết có đối chiếu code.
   - Mức chi tiết mỗi sheet: **hàm chính** (mặc định, ≤ 20 mũi tên) hay **mọi hàm**? Có cần bảng "số mũi tên → hàm → `file:dòng`" cuối mỗi sheet? (mặc định có)
   - Sheet 1 có vẽ cả phần **đối soát tự ghi bù** khi webhook mất (`MISSING_AT_WALLET`) không, hay chỉ happy path thuần?
   - Có cần xuất kèm PNG/SVG không? (môi trường chạy agent có thể không render được draw.io thật.)
4. Trình bày **đề cương** (launch.json: danh sách thay đổi; draw.io: lifeline và khung `alt/par/loop` từng sheet) và **chờ người học duyệt** trước khi sửa và vẽ chi tiết.

### Giai đoạn 1: Yêu cầu 1, launch.json debug cả hai container
Sau khi người học trả lời:
- Thêm compound (và `tasks.json` nếu được chọn) theo đúng quy ước file hiện có: tên cấu hình nhất quán, `skipFiles` giống các cấu hình khác, `localRoot: ${workspaceFolder}`, `remoteRoot: /app`, `restart: true`, `stopAll: true`. Thứ tự: payment trước, wallet sau (wallet gọi payment).
- Không xóa hoặc đổi nghĩa các cấu hình hiện có (cục bộ `envFile`, attach đơn lẻ, test vitest).
- Cập nhật `docs/training/nodejs-1-tuan/ngay-3-huong-dan-debug-topup.md` mục 4.3 để mô tả compound mới và cách chạy từng bước (Windows, PowerShell), kèm xử lý sự cố (cổng 9229/9230 bận, container chưa khởi động xong, breakpoint xám, sửa code mà chưa restart).
- **Kiểm chứng:** JSON hợp lệ; `prettier --check` qua; mọi tên cấu hình trong `compounds` tồn tại trong `configurations`; `docker compose -f deploy/compose.local.yml -f deploy/compose.debug.yml --env-file deploy/.env config` nếu có Docker. Việc gắn debugger thật vào container **chỉ có thể xác nhận trên máy người học**: ghi **[CHƯA CHẠY]** và đưa checklist 5–7 bước để họ tự xác nhận (log `Debugger listening`, breakpoint đỏ, hit breakpoint ở `request-topup.ts` và `create-charge.ts` trong cùng một lần nạp).

### Giai đoạn 2: Yêu cầu 2, `topup-flows.drawio` (3 sheet, sequence diagram)
Quy cách chung (mỗi sheet):
- **Sequence diagram**: lifeline, activation, mũi tên đồng bộ / `await` (nhường event loop) / trả về, khung `alt` / `par` / `loop` khi cần. Dùng đúng hệ màu và legend của `runtime-request-sequence.drawio`.
- Lifeline gợi ý: Client, Wallet HTTP (controller), `RequestTopup`, `InlineTopupSubmitter` / `Worker`, `SubmitTopup`, `HttpPaymentGateway`, DB wallet, Payment HTTP (`charges.route`), `CreateCharge`, DB payment, Payment worker (`CompleteDueCharges`, `DeliverDueWebhooks`), `HttpWebhookSender`, Wallet webhook (`WebhooksController`, `ApplyPaymentResult`). Rút gọn nếu quá rộng, theo mức chi tiết đã chọn.
- Mỗi mũi tên đánh số, ghi **hàm thật + `file:dòng`**; mỗi lifeline có chú thích chức năng chính và lớp kiến trúc; cuối sheet có bảng số mũi tên → hàm → `file:dòng` và ô "Điều cần nhớ" 3–5 gạch đầu dòng.
- Ghi trạng thái dữ liệu trên sơ đồ ở những điểm đổi: `topups.status` (REQUESTED, PENDING, SUCCEEDED, FAILED), `attempts`, `next_attempt_at`; `charges.status` (PENDING, SUCCEEDED, FAILED); `webhook_events.status` (PENDING, DELIVERED, FAILED) (các giá trị có trong migration).
- Chỉ ra rõ điểm nào **đồng bộ**, điểm nào **bất đồng bộ không chờ** (`submitSoon`), điểm nào do **Worker** (macrotask qua `setTimeout`).
- Correlation id: wallet **không truyền** sang payment; nếu nhắc đến chỉ ghi chú "không truyền" (đừng vẽ như có truyền).

Nội dung từng sheet:
- **Sheet 1: happy case.** `POST /topups` → ghi topup + idempotency trong một transaction → trả `202` → `submitSoon` chạy nền → gửi `POST /charges` → payment lưu charge, trả `202 {chargeId}` → wallet ghi `PENDING` → worker payment hoàn tất charge và tạo webhook event → gửi webhook → wallet `ApplyPaymentResult` → ghi sổ kép (`topup:<topupId>`) → `SUCCEEDED`. Đánh dấu thời điểm client nhận `202` và thời điểm tiền thật sự vào ví.
- **Sheet 2: bị trùng.** Các nhánh người học đã chọn, mỗi nhánh một khung `alt`; với từng nhánh nêu: cơ chế chặn trùng (bảng/khóa nào), kết quả client nhìn thấy (mã trả về, `replayed`), có gửi lại sang payment không, có ghi sổ lần hai không, và `file:dòng`.
- **Sheet 3: payment chậm, retry, circuit breaker.** Theo phương án đã chọn (A/B/C):
  - Luồng chính: gửi `POST /charges` → quá `PAYMENT_TIMEOUT_MS` → `AbortSignal` hủy → kết quả `unavailable` → `recordUnavailable` (tăng `attempts`, đặt `next_attempt_at` theo backoff, giữ `REQUESTED`) → `Worker` đến hạn → `SubmitDueTopups` → `executeNextDue` → thử lại → thành công thì `PENDING`; hết bậc thì `FAILED` với `PAYMENT_UNAVAILABLE`; webhook thành công đến muộn vẫn chuyển `SUCCEEDED`.
  - Nêu **client có nhận `202` ngay hay không** khi payment chậm (có, vì gửi chạy nền).
  - Nếu chọn B: lớp circuit breaker vẽ **khác màu, nhãn "ĐỀ XUẤT - chưa có trong code"**, ba trạng thái và điều kiện chuyển; nêu vị trí đặt hợp lý và rủi ro (ví dụ ảnh hưởng tới retry của Worker, idempotency, đối soát). Không dẫn `file:dòng` cho thứ chưa tồn tại.
  - **Bằng chứng chạy thật** (bắt buộc cho phần timeout và retry): lab dùng code thật `HttpPaymentGateway` (với `fetchImpl` chậm tôn trọng `AbortSignal`) và `Topup.recordUnavailable`/`isDue` (hoặc `SubmitTopup` với DB giả), in ra dãy `attempts`, `next_attempt_at`, trạng thái qua các lần thử, và thời điểm `FAILED`. Ghi kết quả đo vào sheet.

### Giai đoạn 3: Kỹ thuật tạo file draw.io
- Viết **XML không nén** (`<mxfile>` nhiều `<diagram name="...">`), bằng script sinh XML đặt trong **thư mục scratchpad của phiên** (không đưa script vào repo, trừ khi người học yêu cầu).
- Mỗi `mxCell` có `id` duy nhất; mọi `edge` có `sourcePoint`/`targetPoint` hoặc `source`/`target` hợp lệ; chữ ≥ 11pt; dùng lưới, không để chữ đè lên mũi tên; tránh ký tự emoji (dùng chữ như "await").
- Mỗi sheet vừa một màn hình A3 ngang (có thể cuộn); có hộp **Legend** và ghi chú đọc sơ đồ; đặt tên sheet đúng: `1. Happy case`, `2. Bị trùng`, `3. Payment chậm, retry, circuit breaker`.
- Phân tích XML bằng `python -I` (well-formed, không trùng `id`, mọi `edge` có đầu cuối). Nếu không có draw.io để render, dựng bản xem trước SVG/HTML rồi chụp bằng Chromium (có sẵn ở `/opt/pw-browsers`) để soát chữ chồng lấn, và ghi rõ đó là **bản xem trước tương đương, không phải render của draw.io**.

### Giai đoạn 4: Kiểm chứng và bàn giao
- Mở lại **mọi `file:dòng`** trong sơ đồ và tài liệu để chắc còn đúng; chạy lại mọi lab dùng làm bằng chứng.
- Chạy `corepack pnpm typecheck`, `lint`, `format:check`; báo kết quả nguyên văn (không báo xanh khi chưa chạy).
- Cập nhật liên kết ở `docs/training/nodejs-1-tuan/README.md` hoặc `ngay-3-kien-truc-va-di.md` tới file draw.io mới.
- Báo cáo cuối: danh sách file thay đổi, bảng "đã chạy / chưa chạy (cần Docker, VS Code, SQL Server thật)", câu hỏi còn mở. Sau khi được phép: nhánh mới từ `main`, commit, push; không mở PR nếu chưa được yêu cầu.

### Tiêu chí hoàn thành
- Người học bấm F5 một lần với compound mới và gắn được debugger vào **cả hai** container (xác nhận trên máy họ qua checklist); mọi cấu hình cũ vẫn dùng được; `format:check` không còn đỏ vì `launch.json`.
- Từ `topup-flows.drawio`, người học trả lời được mà không cần đọc code: thứ tự các bước của một lần nạp thành công; mỗi loại "trùng" được chặn ở đâu và client thấy gì; khi payment chậm thì chuyện gì xảy ra ở từng bước, retry theo lịch nào, khi nào `FAILED`, và **repo có hay không có circuit breaker**.
- Mỗi mũi tên và component có `file:dòng` đúng; mọi chỗ chưa kiểm chứng ghi rõ **[CHƯA CHẠY]** hoặc **[GIẢ THUYẾT]**.
