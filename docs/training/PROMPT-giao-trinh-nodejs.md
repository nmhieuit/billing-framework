# Prompt: sinh giáo trình Node.js 1 tuần từ source `billing-framework`

> Cách dùng: mở phiên Claude Code ở thư mục gốc repo, gõ `/engineering:documentation`, rồi dán nguyên phần
> "PROMPT" bên dưới. Trả lời các câu hỏi ở Giai đoạn 0 trước khi agent viết bất kỳ bài nào.

---

## PROMPT

### Vai trò
Bạn là kỹ sư Node.js/TypeScript senior kiêm người viết giáo trình kỹ thuật. Bạn viết cho **một người học duy nhất**:
một software manager đã có kinh nghiệm lập trình .NET, **chưa từng lập trình Node.js**. Tiếng Việt, giọng thực dụng, không dạy lại kiến thức lập trình căn bản.

### Mục tiêu
Viết giáo trình **1 tuần (7 ngày)**, mỗi ngày gồm lý thuyết + thực hành, **bám trực tiếp vào source trong repo này**
(`packages/*`, `services/wallet`, `services/payment`, `db/*`, `tools/*`, `tests/*`, `deploy/*`).
Sau tuần học, người học phải **tự làm được**:
1. Đọc hiểu cách các service chạy ở runtime (khởi động, vòng đời, event loop, bất đồng bộ, tắt êm).
2. Debug: đặt breakpoint, attach debugger, đọc stack trace, đọc log có correlation id.
3. Troubleshoot sự cố thật của hệ thống này (SQL Server, RabbitMQ, outbox/DLQ, webhook, retention, đối soát) bằng log, metric, test và runbook sẵn có.

### Quy tắc bắt buộc: HỎI LẠI, KHÔNG SUY DIỄN
- **Không được tự giả định** bất cứ điều gì chưa có bằng chứng trong repo hoặc chưa được người học xác nhận. Điều gì không chắc, **dừng lại và hỏi** (dùng AskUserQuestion), mỗi lần tối đa 4 câu, có phương án gợi ý.
- Mọi khẳng định về code phải kèm `đường/dẫn/file.ts:số_dòng` đã **mở và đọc thật**. Không trích dẫn theo trí nhớ. Không đoán hành vi từ tên hàm.
- Phần so sánh với .NET chỉ dùng khi chắc chắn tương đương; nếu không chắc, ghi rõ "khác/không tương đương" hoặc hỏi lại. Không dựng ví dụ .NET khi người học chưa xác nhận phiên bản/framework họ quen.
- Lệnh chạy được phải **đã chạy thử** trong môi trường này. Lệnh không chạy được (cần Docker, mạng...) phải ghi rõ "chưa kiểm chứng" kèm lý do, không được tả kết quả đoán.
- Gặp mâu thuẫn giữa docs và code: **code là nguồn đúng**, nêu mâu thuẫn cho người học, không tự sửa docs cũ.
- Không sửa code nghiệp vụ. Chỉ tạo file trong `docs/training/nodejs-1-tuan/`. Không commit/push cho tới khi được yêu cầu.

### Thông tin người học đã xác nhận (không hỏi lại)
- IDE: VS Code. Máy có Docker Desktop, chạy được SQL Server container.
- .NET: ASP.NET Core, EF Core, RabbitMQ (chưa xác nhận phiên bản C#, có dùng MassTransit hay không).
- Thời lượng: 4 giờ/ngày. Mỗi bài phải chia khung giờ cho vừa 4 giờ.
- Đầu ra: nhiều file Markdown trong `docs/training/nodejs-1-tuan/`.
- Cần bài kiểm tra cuối mỗi ngày, có đáp án (đáp án để file riêng hoặc phần cuối bài).

- Hệ điều hành: Windows (lệnh PowerShell/WSL, lưu ý đường dẫn và Docker Desktop).
- .NET: C# hiện đại, có dùng MassTransit.
- JavaScript/TypeScript: chưa biết gì, nên Ngày 1 phải dạy cú pháp nền tảng.
- Ưu tiên troubleshoot: tiền/ledger/idempotency, rồi messaging/outbox/DLQ.
- Thuật ngữ: giữ tiếng Anh kèm giải thích tiếng Việt.

### Giai đoạn 0 — Khảo sát và hỏi (làm trước, chưa viết bài)
1. Đọc: `README.md`, `package.json`, `pnpm-workspace.yaml`, `tsconfig*.json`, `eslint.config.js`, `vitest*.config.ts`, `docs/architecture/README.md`, các ADR trong `docs/adr/`, `docs/ops/*`, `docs/integration/*`, `docs/QA/*`.
2. Lập **bản đồ code** (liệt kê file đã đọc): điểm vào của từng service, các package dùng chung, luồng chính (nạp ví, thanh toán order, outbox, webhook, đối soát, retention, ops tools).
3. Chạy thử trong môi trường hiện tại: `corepack pnpm install`, `typecheck`, `lint`, `test`. Ghi lại cái nào chạy được/không và vì sao.
4. **Hỏi người học** (bắt buộc, chưa trả lời thì chưa viết):
   - Máy học là OS nào? Đã có Node 22, Docker, IDE (VS Code/Rider/WebStorm) chưa? IDE nào sẽ dùng để debug?
   - Kinh nghiệm .NET cụ thể: C# phiên bản nào, ASP.NET Core/Web API, EF Core, async/await, DI, RabbitMQ/MassTransit? (để chọn chỗ so sánh đúng).
   - Đã biết JavaScript/TypeScript ở mức nào (đọc được `async/await`, `Promise`, destructuring, module `import/export`)?
   - Thời gian thực tế mỗi ngày (giờ)? Có Docker chạy được `deploy/compose.local.yml` không (SQL Server cần RAM nhiều)?
   - Ưu tiên troubleshoot nhóm sự cố nào trước (tiền/ledger, messaging/DLQ, hiệu năng, triển khai)?
   - Ngôn ngữ thuật ngữ: giữ tiếng Anh gốc kèm giải thích tiếng Việt, hay dịch hoàn toàn?
   - Định dạng đầu ra: nhiều file Markdown trong repo, hay một file duy nhất, hay cả hai?
   - Có cần bài kiểm tra cuối ngày và đáp án không?
5. Trình bày **đề cương 7 ngày** (tiêu đề, mục tiêu, file sẽ dùng) và **chờ người học duyệt** trước khi viết chi tiết.

### Giai đoạn 1 — Cấu trúc mỗi ngày (khuôn bắt buộc)
Mỗi file `ngay-N-<chu-de>.md` gồm:
1. **Mục tiêu hôm nay** (3–5 gạch đầu dòng, đo được).
2. **Chuẩn bị** (lệnh cài đặt/chạy, đã kiểm chứng).
3. **Lý thuyết** (ngắn, mỗi khái niệm: là gì → vì sao Node làm vậy → bảng đối chiếu với .NET nếu chắc → **chỉ ra nơi dùng trong repo** `file:dòng`).
4. **Đọc code có hướng dẫn**: danh sách file đọc theo thứ tự, mỗi file kèm 2–4 câu hỏi dẫn dắt.
5. **Thực hành** (bước đánh số, kết quả mong đợi, cách kiểm tra đúng/sai). Ưu tiên thực hành an toàn: chạy test, thêm log, đặt breakpoint, đọc output; nếu cần sửa code thì làm trên nhánh/bản sao và ghi rõ cách hoàn tác.
6. **Thử thách troubleshoot**: một tình huống lỗi có thật hoặc tái hiện được (vd. kịch bản chaos S1–S13, DLQ, retention dry-run) — nêu triệu chứng, để người học tự lần theo, rồi mới có **gợi ý → đáp án**.
7. **Tự kiểm tra** (5–8 câu hỏi + đáp án trỏ về code).
8. **Lỗi thường gặp của người từ .NET sang Node** (chỉ nêu cái có bằng chứng).
9. **Câu hỏi còn mở** cho người dạy/đội dev (những gì agent không xác minh được).

### Giai đoạn 1 — Gợi ý khung 7 ngày (điều chỉnh sau khi người học trả lời)
Đây chỉ là **giả thuyết để hỏi duyệt**, không phải kết luận:
- Ngày 1: Hệ sinh thái và công cụ (Node 22, ESM `"type":"module"`, pnpm workspace, TypeScript, tsx, vitest, eslint) — đối chiếu với solution/csproj/NuGet.
- Ngày 2: Ngôn ngữ và mô hình bất đồng bộ (event loop, Promise, async/await, error handling, stream) — đọc `packages/runtime`, `packages/money`.
- Ngày 3: Cấu trúc kiến trúc và DI (NestJS wallet vs Fastify payment, ranh giới package — xem `tools/boundaries.test.ts`).
- Ngày 4: Dữ liệu: Kysely, transaction/unit-of-work, migration, ledger sổ kép — `packages/database`, `db/*`, `services/wallet/src/infrastructure/kysely`.
- Ngày 5: Messaging: RabbitMQ (amqplib), outbox, consumer, idempotency, DLQ — `packages/messaging`, `packages/contracts`.
- Ngày 6: Debug và quan sát: debugger Node, source map, log/correlation id, OpenTelemetry, Kibana — `packages/observability`, `docs/ops/*`.
- Ngày 7: Troubleshoot tổng hợp: chaos test, bất biến về tiền, retention, ops tools, runbook; bài kiểm tra cuối tuần.

### Giai đoạn 2 — Kiểm chứng trước khi bàn giao
- Chạy lại mọi lệnh trong giáo trình; liệt kê bảng "đã chạy / chưa chạy được + lý do".
- Soát mọi `file:dòng` còn đúng (mở lại file).
- Soát từ ngữ: không có câu nào là suy đoán mà không gắn nhãn "giả thuyết" hoặc "cần xác nhận".
- Tạo `README.md` mục lục: lộ trình, thời lượng, điều kiện tiên quyết, bảng thuật ngữ Node ↔ .NET (chỉ các cặp đã xác minh), phụ lục "Sổ tay lệnh debug/troubleshoot".
- Báo cáo cuối: danh sách file tạo ra, các điểm chưa kiểm chứng, các câu hỏi còn mở. Không commit khi chưa được cho phép.

### Tiêu chí hoàn thành
- Người học trả lời đúng ≥80% câu tự kiểm tra cuối tuần mà chỉ dùng repo + giáo trình.
- Người học tự đặt được breakpoint trong một service chạy local, bắt được một request/message và giải thích luồng.
- Người học tự chẩn đoán được ít nhất 3 tình huống lỗi (một về tiền/ledger, một về messaging, một về vận hành) theo runbook.
