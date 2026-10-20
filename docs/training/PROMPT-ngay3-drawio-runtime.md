# Prompt: Ngày 3, hai sơ đồ draw.io mô tả runtime của một service

> Cách dùng: mở phiên Claude Code ở gốc repo, gõ `/engineering:documentation` (hoặc `/engineering:system-design`), rồi dán nguyên phần "PROMPT" bên dưới.
> Agent phải trả lời xong các câu hỏi ở Giai đoạn 0 với bạn **trước khi** vẽ.

---

## PROMPT

### Vai trò
Bạn là kỹ sư Node.js/TypeScript senior kiêm người viết tài liệu kỹ thuật, vẽ sơ đồ bằng **draw.io (diagrams.net)**.
Người đọc: software manager, có kinh nghiệm .NET (ASP.NET Core, EF Core, RabbitMQ, MassTransit), **mới học Node.js**, đang ở Ngày 3 của giáo trình `docs/training/nodejs-1-tuan/`. Máy Windows, VS Code, Docker Desktop. Tiếng Việt; thuật ngữ giữ tiếng Anh kèm giải thích tiếng Việt.

### Mục tiêu
Tạo **2 file draw.io** (đuôi `.drawio`, mở được bằng draw.io Desktop, app.diagrams.net và extension VS Code "Draw.io Integration") trong `docs/training/nodejs-1-tuan/diagrams/`:

**File 1: `runtime-lifecycle.drawio`**: vòng đời runtime của MỘT service, trả lời:
1. Khi chạy lên, những component nào được **khởi tạo**, theo thứ tự nào, bởi file nào.
2. Cái gì chạy **một lần** khi app start; cái gì chạy **một lần khi deploy bản mới** (ví dụ job migration, job khởi tạo hạ tầng; xác định có thật trong repo, không đoán).
3. Cái gì chạy **lặp lại nhiều lần**: mỗi lần endpoint được gọi; mỗi message từ hàng đợi; mỗi tick của worker nền (định kỳ).
4. Cái gì chạy khi **tắt** service.

**File 2: `runtime-request-sequence.drawio`**: **sequence diagram** của MỘT endpoint được gọi, trả lời:
1. **Bao nhiêu hàm** được gọi và **theo thứ tự nào** (từ lúc request vào tới lúc response ra), kèm `file:dòng`.
2. Điểm nào là **đồng bộ**, điểm nào là `await` (nhường quyền cho event loop), điểm nào là việc **chạy nền không chờ**.
3. Nếu request A **chưa xử lý xong** mà request B gọi **cùng endpoint**, runtime xử lý thế nào: B có bị chặn không, hai request xen kẽ ở đâu, tài nguyên nào dùng chung (pool kết nối DB, khóa hàng, idempotency key, `AsyncLocalStorage`) và chúng hoạt động ra sao.

Cả hai sơ đồ là **bản tổng quát trước** (mức 1): chỉ cần thấy luồng chính và **chức năng chính của từng component trong source code**. Chưa đi sâu từng nhánh lỗi.

### Quy tắc bắt buộc: HỎI LẠI, KHÔNG SUY DIỄN
- Điều gì chưa chắc hoặc chưa được người học xác nhận: **dừng và hỏi** (AskUserQuestion, tối đa 4 câu mỗi lần, có phương án gợi ý). Không tự chọn thay người học.
- Mọi mũi tên, hàm, component trong sơ đồ phải kèm **`file:dòng` đã mở và đọc thật**. Không vẽ theo trí nhớ hoặc theo tên hàm.
- Hành vi runtime (thứ tự, đồng thời, microtask) phải **chạy thử bằng code thật** của repo (kiểu các lab trong `docs/training/nodejs-1-tuan/labs/`) rồi mới ghi vào sơ đồ. Cái gì chưa kiểm chứng ghi nhãn **[CHƯA CHẠY]** hoặc **[GIẢ THUYẾT]** ngay trên sơ đồ.
- Không sửa code service. Không áp dụng bản vá nào vào repo. Chỉ tạo file trong `docs/training/nodejs-1-tuan/diagrams/` (và có thể một file mô tả ngắn kèm theo). Không commit/push khi chưa được cho phép trong phiên.
- Khi docs và code mâu thuẫn: code là nguồn đúng; nêu mâu thuẫn cho người học.

### Thông tin đã xác nhận (không hỏi lại)
- Vẽ theo **sequence diagram** (lifeline, activation, message đồng bộ/trả về), có **chú thích cho từng component**.
- Chỉ cần **luồng tổng quát** và **chức năng chính của từng component**.
- Hai file draw.io, tiếng Việt, thuật ngữ giữ tiếng Anh kèm giải thích.
- Repo: pnpm workspace, TypeScript, Node 22; wallet dùng NestJS trên Fastify, payment dùng Fastify thuần; 4 lớp `domain/application/infrastructure/interface` (`docs/architecture/README.md`).

### Điểm xuất phát đã kiểm chứng (phải đối chiếu lại bằng cách đọc code, không chép nguyên)
- Wallet điểm vào `services/wallet/src/main.ts`; composition root `services/wallet/src/bootstrap.ts` (`startService`); `startOrExit`, `createShutdownHandler`, `Worker`, `runAll`, `once` ở `packages/runtime/src/`.
- Thứ tự khởi động của wallet trong `bootstrap.ts`: tạo DB (`createDatabase`), `assertMigrated`, `BrokerClient.connect`, dựng use case, `broker.consume`, `createApp` (Nest+Fastify), `new Worker(...).start()` (4 worker: nghiệp vụ, đối soát, lấy mẫu trạng thái, retention), trả `stop()`.
- Tắt: `stop = once(() => runAll([...]))` (`bootstrap.ts` cuối file); tín hiệu SIGINT/SIGTERM trong `main.ts`.
- Ví dụ endpoint đơn giản: `GET /wallet` (`WalletsController.get` → `GetWallet.execute` → `uow.run` → `accounts.find`); ví dụ endpoint có chạy nền sang payment: `POST /topups`.
- Event loop: phần sau `await` là microtask; `Worker` đặt tick kế bằng `setTimeout`; `process.nextTick`, `queueMicrotask`, `setImmediate` **không** có trong code production (đã `grep`).
- Hạ tầng triển khai local: `deploy/compose.local.yml` (include `compose.infra.yml`, `compose.services.yml`); job `migrate`, `billing-sql-init`, `billing-rabbitmq-init`, `kibana-import` chạy một lần rồi thoát.

### Giai đoạn 0: Khảo sát và HỎI (làm trước, chưa vẽ)
1. Đọc: `services/<service>/src/main.ts`, `bootstrap.ts`, `app.module.ts` (wallet) hoặc `interface/http/app.ts` (payment), `packages/runtime/src/*`, `packages/observability/src/*`, `packages/database/src/connection.ts`, `deploy/compose.services.yml`, các ADR liên quan.
2. Lập danh sách component thật (file, lớp/hàm, lớp kiến trúc, vòng đời: một lần / mỗi request / mỗi message / định kỳ / khi tắt). Ghi lại các file đã đọc.
3. Đọc cấu hình pool kết nối DB (`packages/database/src/connection.ts`) và cấu hình Kysely/tedious để trả lời câu hỏi đồng thời; nếu không thấy cấu hình tường minh, ghi rõ "chưa tìm thấy", không suy ra.
4. **Hỏi người học** (bắt buộc; chưa trả lời thì chưa vẽ):
   - File 1 mô tả **service nào**: `wallet` hay `payment`? (người học viết "1 service"; không tự chọn.)
   - File 2 dùng **endpoint nào**? Gợi ý: `GET /wallet` (đơn giản, chỉ đọc), `POST /topups` (có chạy nền sang payment), `POST /charges` (payment). Nếu endpoint là `POST /topups`, có cần vẽ cả phần chạy nền gửi sang payment không, hay dừng ở lúc trả `202`?
   - Mức chi tiết của file 2: chỉ **các hàm chính** (controller, guard, use case, repository) hay **mọi hàm** (kể cả middleware, mapper, view)? Gợi ý mặc định: hàm chính, ≤ 15 mũi tên.
   - File 1 muốn **một trang** hay **nhiều trang** (ví dụ trang 1: khởi tạo; trang 2: chạy lặp lại; trang 3: tắt)?
   - Có cần xuất kèm **PNG/SVG** để xem nhanh không? (agent có thể không render được draw.io trong môi trường chạy; nếu không render được phải nói rõ.)
   - Phần "deploy bản mới": có cần vẽ các job `migrate`, `billing-sql-init`, `billing-rabbitmq-init` (ngoài process service) không?
   - Với tình huống "request B đến khi request A chưa xong": muốn minh họa bằng **hai request chạy xen kẽ** trong một sơ đồ sequence (hai nhóm mũi tên cùng thời gian) hay một **sơ đồ riêng** cho phần đồng thời?
5. Trình bày **đề cương** hai file (danh sách lifeline/khối, các nhóm màu, chú thích) và **chờ người học duyệt** trước khi vẽ chi tiết.

### Giai đoạn 1: File 1, vòng đời runtime
Yêu cầu nội dung (điều chỉnh theo câu trả lời ở Giai đoạn 0):
- Chia **bốn vùng/làn màu** có chú giải (legend) rõ trong file:
  1. **Một lần khi deploy bản mới** (ngoài process: job migration, job khởi tạo hạ tầng; chỉ vẽ những gì có thật trong `deploy/` và `package.json`).
  2. **Một lần khi process start** (theo đúng thứ tự trong `main.ts` rồi `bootstrap.ts`).
  3. **Lặp lại khi chạy** (ba nhóm con: mỗi request HTTP; mỗi message hàng đợi; mỗi tick worker định kỳ).
  4. **Khi tắt** (`SIGTERM` → `createShutdownHandler` → `stop()` → `runAll`, thứ tự đóng).
- Dùng **sequence diagram** hoặc swimlane có trục thời gian từ trên xuống, nhưng mọi component vẫn là lifeline/khối có chú thích. Nếu pha trộn hai kiểu, phải nói rõ ở legend.
- Mỗi component có **chú thích** (note) gồm: tên, `file:dòng`, chức năng chính 1–2 câu, tần suất chạy (một lần / mỗi request / định kỳ), lớp kiến trúc.
- Chỉ ra **tài nguyên được tạo một lần và dùng lại** (pool DB, broker client, Nest app, các instance use case) và **tài nguyên tạo mới mỗi request** (transaction, `AsyncLocalStorage` context, đối tượng repository trong `uow.run`). Mỗi khẳng định kèm `file:dòng`.
- Ghi chú ở các điểm `await` hoặc `setTimeout` ảnh hưởng thứ tự (Ngày 2).

### Giai đoạn 2: File 2, sequence diagram một endpoint
Yêu cầu nội dung:
- Lifeline theo thứ tự thật: Client, Fastify/Nest (router), `CorrelationMiddleware`, Guard, Controller, Use case (`application`), `TenantUnitOfWork` (`uow.run`), Repository, Kysely/tedious, SQL Server, và (nếu chọn endpoint có chạy nền) `InlineTopupSubmitter`, `HttpPaymentGateway`, Payment.
- Mỗi mũi tên đánh số thứ tự, ghi **tên hàm thật + `file:dòng`**; message đồng bộ nét liền, `await`/I/O có chú thích "nhường event loop", trả về nét đứt. Đánh dấu rõ ranh giới trả response cho client.
- Dùng khung `par`/`alt`/`loop` của UML khi cần (đồng thời, rẽ nhánh, lặp).
- **Phần đồng thời** (bắt buộc): trả lời bằng bằng chứng chạy thật, không bằng lý thuyết suông:
  - Chạy lab dùng code thật của use case (xem `labs/get-wallet-async.ts`, `labs/topup-async-flow.ts` làm mẫu), phát hai request chồng thời gian, ghi log thứ tự.
  - Vẽ: request B **không bị chặn** ở các điểm `await`; hai request chạy xen kẽ trên cùng một luồng JS; mỗi request có transaction và context riêng.
  - Nêu **tài nguyên dùng chung** và hệ quả, chỉ ghi khi đã tìm thấy bằng chứng trong code: pool kết nối (giới hạn?), khóa hàng (`updlock`) nếu endpoint ghi, khóa idempotency, lỗi trùng khóa và cơ chế thử lại một lần (nếu endpoint có). Nếu endpoint chỉ đọc (`GET /wallet`), nói rõ không có khóa.
  - Nếu có một phần không kiểm chứng được (ví dụ giới hạn của pool, hành vi khi hết kết nối): ghi **[CHƯA CHẠY]** hoặc **[GIẢ THUYẾT]** và đưa vào "Câu hỏi còn mở".
- Mỗi lifeline có **chú thích chức năng chính** (note) và lớp kiến trúc; cuối sơ đồ có bảng chú thích số mũi tên → `file:dòng`.

### Giai đoạn 3: Cách tạo file draw.io (kỹ thuật)
- Viết trực tiếp XML **không nén**: `<mxfile><diagram name="..." id="..."><mxGraphModel>...<root>...` (không dùng định dạng nén base64) để dễ review diff trong git.
- Lifeline dùng style UML của draw.io (ví dụ `shape=umlLifeline;perimeter=lifelinePerimeter;container=1;collapsible=0;recursiveResize=0;`), note dùng `shape=note`, khung `par/alt/loop` dùng `shape=umlFrame`. Mỗi `mxCell` có `id` duy nhất; mọi `edge` có `source`/`target` hợp lệ hoặc điểm tọa độ.
- Cỡ chữ ≥ 12, không chồng lấn chữ lên mũi tên; chia theo lưới để khỏi rối; khung kích thước vừa một màn hình A3 ngang, có thể cuộn.
- Màu theo vòng đời (legend): ví dụ xanh lá = một lần khi start, xanh dương = mỗi request, cam = định kỳ (worker), đỏ nhạt = khi tắt, xám = ngoài process (deploy). Màu phải dùng nhất quán giữa hai file.
- Có hộp **Legend** và hộp **Ghi chú đọc sơ đồ** trong mỗi file.

### Giai đoạn 4: Kiểm chứng trước khi bàn giao
- Phân tích XML bằng script (`python -I`): well-formed; `id` không trùng; mọi `edge` tham chiếu `source`/`target` tồn tại; số lifeline, số mũi tên khớp với đề cương.
- Nếu có `drawio` CLI hoặc thư viện render: xuất thử PNG/SVG và xem bằng mắt; nếu không: ghi rõ **[CHƯA RENDER]** và nói người học mở thử bằng VS Code extension.
- Mở lại **mọi `file:dòng`** trong sơ đồ để chắc còn đúng.
- Chạy lại các lab đã dùng làm bằng chứng; ghi kết quả (ngày giờ, lệnh).
- Chạy `corepack pnpm typecheck`, `lint` nếu có thêm file `.ts` (lab). Docs bị `prettier` bỏ qua.
- Báo cáo cuối: danh sách file tạo ra, bảng "đã chạy / chưa chạy", câu hỏi còn mở. Không commit/push khi chưa được cho phép; sau khi được phép, push lên nhánh được chỉ định.

### Tiêu chí hoàn thành
- Người học trả lời được từ sơ đồ (không cần đọc code): thứ tự khởi tạo của service; cái gì chạy một lần, cái gì lặp lại; bao nhiêu hàm được gọi cho endpoint đã chọn và theo thứ tự nào; khi hai request chồng nhau điều gì xảy ra ở từng điểm `await`.
- Mỗi component trên sơ đồ có chú thích chức năng chính và `file:dòng` đúng.
- Cả hai file mở được trong draw.io không lỗi, đọc được trên một màn hình, có legend.
