# Prompt: giáo trình Node.js 7 ngày, căn bản, thiên về thực hành (thay thế giáo trình cũ)

> Cách dùng: mở phiên Claude Code ở gốc repo, gõ `/engineering:documentation`, rồi dán nguyên phần "PROMPT" bên dưới.
> Agent phải hỏi bạn các câu ở Giai đoạn 0 **trước khi** xóa file cũ hay viết bài.

---

## PROMPT

### Vai trò
Bạn là kỹ sư Node.js/TypeScript senior kiêm giảng viên thực hành, giỏi giải thích từ con số không. Bạn viết cho **một người học duy nhất**:
một **software manager** biết lập trình căn bản (biến, hàm, vòng lặp, điều kiện, cấu trúc dữ liệu) và biết thiết kế hệ thống ở mức khái niệm (service, API, database, queue), **chưa từng viết Node.js** và chưa quen JavaScript/TypeScript.
Máy Windows, VS Code, Docker Desktop. Tiếng Việt; thuật ngữ giữ tiếng Anh kèm giải thích tiếng Việt ngắn.

### Mục tiêu
Thiết kế lại giáo trình **7 ngày**, **căn bản hơn rất nhiều** so với giáo trình cũ (đã quá phức tạp, người học không nắm được), **thiên về thực hành**: người học **gõ code từng dòng**, chạy, sửa lỗi, và làm **nhiều bài tập nhỏ tăng dần độ khó từ căn bản đến nâng cao**, trước khi **chọn một luồng thật của dự án** `billing-framework` để đọc, chạy, debug và sửa nhỏ.

Sau 7 ngày, người học phải tự làm được:
1. Viết và chạy chương trình Node.js/TypeScript nhỏ từ đầu (không chép từ ví dụ có sẵn).
2. Hiểu và dùng: module, hàm, mảng/đối tượng, bất đồng bộ (`Promise`, `async/await`), xử lý lỗi, test tự động.
3. Dựng một HTTP API nhỏ có validate, test, lưu dữ liệu và gọi một service khác có timeout và retry.
4. Đọc code, chạy và debug **một luồng thật** của dự án bằng debugger VS Code.

### Nguyên tắc sư phạm bắt buộc
- **Không dùng .NET (hay ngôn ngữ nào khác) làm ví dụ so sánh.** Giải thích mọi khái niệm bằng ngôn ngữ đời thường và ví dụ nhỏ trong Node/TypeScript.
- **Mỗi bài chỉ tối đa 3 khái niệm mới.** Khái niệm nào chưa được dạy thì không được dùng trong bài trước đó.
- **Gõ theo từng dòng:** mỗi đoạn code hướng dẫn ≤ 20 dòng, sau đó là bảng "dòng → ý nghĩa". Người học gõ lại, không dán.
- **Chu trình lặp cho mỗi khái niệm:** xem ví dụ chạy được → đoán kết quả → chạy kiểm tra → sửa một chỗ → bài tập tương tự → bài tập khó hơn.
- **Bài tập nhỏ** (mỗi ngày 6-10 bài, mỗi bài làm trong 10-30 phút), gắn nhãn mức **Cơ bản / Trung bình / Nâng cao**, xếp **tăng dần trong ngày và qua các ngày**. Mỗi bài có: đề, file bắt đầu (starter) có chỗ `TODO`, **test tự động** để tự chấm, tiêu chí đạt, gợi ý 3 mức (nhẹ → nặng), và **lời giải tham khảo đặt riêng** (không nằm cạnh đề).
- **Lỗi là một phần của học:** mỗi ngày có 2-3 "bài sửa lỗi" (code có sẵn lỗi, người học đọc thông báo lỗi và sửa), dạy cách đọc stack trace.
- Cuối mỗi ngày: **bài kiểm tra ngắn** (5-8 câu, có đáp án) và **checklist** "tôi đã làm được".
- Từ vựng: có **bảng thuật ngữ** dùng chung; lần đầu gặp một thuật ngữ phải giải thích ngay.
- Ngày 7 mới dùng code thật của dự án. Các ngày trước dùng ví dụ tự dựng nhỏ (có thể mang chủ đề tiền/ví/nạp tiền để làm cầu nối nhưng **phải đơn giản hơn nhiều** code thật).

### Quy tắc bắt buộc: HỎI LẠI, KHÔNG SUY DIỄN
- Điều gì chưa chắc hoặc chưa được người học xác nhận: **dừng và hỏi** (AskUserQuestion, tối đa 4 câu mỗi lần, có phương án gợi ý, đánh dấu phương án khuyến nghị). Không tự chọn thay người học.
- **Mọi ví dụ và bài tập phải được chạy thật** trong môi trường (Node theo `.nvmrc`, đúng phiên bản thư viện của repo) trước khi đưa vào giáo trình, cùng với lời giải và test. Ghi lại lệnh đã chạy và kết quả. Cái nào không chạy được (cần Docker, VS Code, Windows) ghi **[CHƯA CHẠY]**; cái nào suy luận ghi **[GIẢ THUYẾT]**.
- Mọi khẳng định về code của repo (Ngày 7) kèm **`file:dòng` đã mở đọc thật**. Khi in số dòng dùng `cat -n` cho **MỘT file mỗi lệnh** (nhiều file một lệnh làm số dòng cộng dồn và sai, từng xảy ra trong repo này).
- Không sửa code trong `services/` và `packages/` khi viết giáo trình (Ngày 7 chỉ cho người học sửa trên nhánh học, có hướng dẫn hoàn tác).
- Khi docs và code mâu thuẫn: code là nguồn đúng; nêu mâu thuẫn cho người học.

### Giai đoạn 0: Khảo sát và HỎI (làm trước, chưa xóa, chưa viết)
1. Liệt kê nội dung `docs/training/nodejs-1-tuan/` hiện có (README, 7 bài ngày, thư mục `labs/`, `diagrams/`) và các file `docs/training/PROMPT-*.md`. Đọc `package.json`, `pnpm-workspace.yaml`, `.nvmrc`, `tsconfig.base.json`, `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierignore`, `Jenkinsfile`.
2. Xác minh bằng lệnh (không đoán) cách các công cụ của repo đối xử với **một thư mục bài tập mới**: `tsconfig.json` có `include: ["**/*.ts"]` nên `typecheck` quét mọi file `.ts`; `eslint .` quét mọi file; `prettier` bỏ qua `docs/`; `pnpm-workspace.yaml` chỉ gồm `services/*` và `packages/*`; `vitest` mặc định lấy `**/*.test.ts`. Hệ quả cần kiểm chứng: file starter có `TODO` hoặc test đang đỏ đặt **trong repo** có thể làm `typecheck`, `lint`, `test` và CI **đỏ**. Chạy thử để xác nhận, rồi nêu hệ quả cho người học.
3. **Hỏi người học** (bắt buộc; chưa trả lời thì chưa làm):
   - **Xóa nội dung cũ:** xác nhận xóa **toàn bộ** `docs/training/nodejs-1-tuan/` (gồm 8 file `.md`, `labs/*.ts`, `diagrams/*.drawio`). Lịch sử vẫn còn trong git. Có giữ lại các file `docs/training/PROMPT-*.md` không? (mặc định: giữ.)
   - **Nơi đặt code bài tập:** (a) thư mục riêng **ngoài workspace** của repo, có `package.json` riêng, và thêm vào cấu hình để `typecheck`/`lint`/`test` của repo bỏ qua (khuyến nghị); (b) thư mục **bên ngoài repo** hoàn toàn (ví dụ `C:\node-training`), repo chỉ chứa tài liệu; (c) trong repo như file thường (chấp nhận CI đỏ khi starter chưa làm xong). Nếu chọn (a), liệt kê chính xác file cấu hình nào sẽ sửa và hỏi lại trước khi sửa.
   - **Ngôn ngữ:** học **JavaScript thuần trước** (Ngày 1-2) rồi chuyển **TypeScript** (khuyến nghị, vì dự án dùng TypeScript), hay dùng TypeScript ngay từ Ngày 1?
   - **Quản lý package:** dùng `pnpm` qua `corepack` như repo, hay `npm` cho phần bài tập?
   - **Thời lượng mỗi ngày** (trước đây 4 giờ): giữ 4 giờ hay đổi? Số bài tập mỗi ngày tương ứng.
   - **Dự án nhỏ xuyên suốt** (Ngày 3-6): làm một "mini wallet" (ví, nạp tiền, gọi một payment giả) tăng dần từng ngày, hay các bài rời rạc? Dữ liệu lưu **trong bộ nhớ** (khuyến nghị, không cần cài gì), **file JSON**, hay database thật (SQL Server container)?
   - **Luồng thật ở Ngày 7:** chọn một: `GET /wallet` (đơn giản, chỉ đọc), `POST /topups` (có chạy nền sang payment), hoặc luồng khác người học nêu. Ngày 7 chỉ **đọc, chạy, debug và sửa nhỏ**, hay thêm một test mới?
   - **Docker:** chỉ dùng ở Ngày 7 (khi chạy dự án thật) hay tránh hẳn trong giáo trình này?
   - **Hình thức kiểm tra** cuối ngày: câu hỏi trắc nghiệm ngắn, bài code tự chấm bằng test, hay cả hai? (khuyến nghị: cả hai).
4. Trình bày **đề cương** (xem "Khung đề xuất" bên dưới, điều chỉnh theo câu trả lời): mỗi ngày gồm mục tiêu, danh sách khái niệm mới (≤ 3 mỗi bài), tên các bài tập và mức độ. **Chờ người học duyệt** trước khi xóa và viết chi tiết.

### Khung đề xuất 7 ngày (GIẢ THUYẾT để hỏi duyệt, không phải kết luận)
| Ngày | Chủ đề | Gợi ý nội dung thực hành |
| ---- | ------ | ------------------------ |
| 1 | Cài đặt, chạy chương trình, JavaScript cơ bản | `node` chạy file, `console.log`, biến, kiểu, hàm, điều kiện, vòng lặp, mảng, đối tượng, đọc thông báo lỗi |
| 2 | JavaScript hiện đại và module, rồi TypeScript cơ bản | `import/export`, arrow function, destructuring, `map/filter/reduce`, kiểu và `interface`, `class`, chạy bằng `tsx`, test đầu tiên với `vitest` |
| 3 | Bất đồng bộ | callback, `setTimeout`, `Promise`, `async/await`, `try/catch`, đọc/ghi file, "chuyện gì chạy trước, chuyện gì chạy sau" qua bài tập đoán thứ tự |
| 4 | HTTP API đầu tiên | server `Fastify`, `GET`/`POST`, JSON, mã trạng thái, validate đầu vào, gọi bằng `curl`, test endpoint bằng `inject` |
| 5 | Dữ liệu, tách lớp, chống trùng | repository trong bộ nhớ, tách controller/service/repository, tiền bằng số nguyên, `Idempotency-Key` mini, test các trường hợp trùng |
| 6 | Độ tin cậy | gọi service khác (payment giả), timeout bằng `AbortSignal`, retry theo bậc, chạy nền không chờ (`.catch`), log có cấu trúc, debug bằng VS Code (breakpoint, call stack, watch) |
| 7 | Một luồng thật của dự án | chạy test của dự án, đọc luồng đã chọn theo checklist, đặt breakpoint, vẽ lại luồng bằng lời, sửa nhỏ có test, báo cáo những gì đã hiểu |

### Giai đoạn 1: Dọn nội dung cũ (chỉ sau khi người học đã duyệt)
- Xóa đúng phạm vi người học xác nhận (`git rm -r`), **không** xóa file ngoài phạm vi.
- Sau khi xóa, chạy `corepack pnpm typecheck`, `lint`, `format:check`, `test` và báo kết quả nguyên văn để chắc việc xóa không làm vỡ gì (trước đây các file `labs/*.ts` được `typecheck` và `lint` quét).

### Giai đoạn 2: Viết giáo trình mới
Cấu trúc đầu ra (điều chỉnh theo lựa chọn "nơi đặt code bài tập"):
```
docs/training/nodejs-1-tuan/
  README.md            lộ trình, điều kiện tiên quyết, cách học mỗi ngày, cách tự chấm bài, cách xin hỗ trợ
  ngay-1-....md ... ngay-7-....md
  thuat-ngu.md         bảng thuật ngữ dùng chung
  so-tay-lenh.md       các lệnh hay dùng (PowerShell)
<thư mục bài tập đã chọn>/
  ngay-1/ ... ngay-7/  mỗi bài: starter (có TODO) + test; lời giải đặt ở solutions/ riêng
```
Mỗi file ngày gồm, theo thứ tự: **Mục tiêu** (3-4 gạch, đo được) · **Chuẩn bị** · **Bài học nhỏ** (khái niệm → ví dụ ≤ 20 dòng → bảng dòng/ý nghĩa → "gõ và chạy") · **Bài tập tăng dần** · **Bài sửa lỗi** · **Kiểm tra cuối ngày + đáp án** · **Lỗi thường gặp** · **Checklist** · **Câu hỏi còn mở**.
- Chia mỗi ngày thành các khối ≤ 45 phút, mỗi khối kết thúc bằng một việc người học **chạy được và thấy kết quả**.
- Ngày 7: bài hướng dẫn "đọc code có phương pháp" (bắt đầu từ điểm vào, đi theo hàm được gọi, ghi lại dòng và dữ liệu), cách chạy và debug luồng đã chọn, và 3-5 bài tập nhỏ trên code thật có tiêu chí đạt. Chỉ dùng `file:dòng` đã mở đọc thật.

### Giai đoạn 3: Kiểm chứng trước khi bàn giao
- **Chạy từng bài:** với mỗi bài tập, chạy starter (phải **đỏ** đúng chỗ `TODO`) và lời giải (phải **xanh**); ghi lại vào bảng "đã chạy / chưa chạy" cuối README.
- Chạy mọi lệnh trong "Chuẩn bị" và "so-tay-lenh.md" ở mức có thể (môi trường biên soạn là Linux; lệnh PowerShell ghi **[CHƯA CHẠY]**).
- Soát độ khó: không bài nào dùng khái niệm chưa dạy; không bài nào có quá 3 khái niệm mới; thời lượng mỗi ngày khớp lựa chọn của người học.
- Soát ngôn từ: không còn so sánh với .NET hay công nghệ khác; mọi thuật ngữ có trong bảng thuật ngữ.
- Chạy `corepack pnpm typecheck`, `lint`, `format:check`, `test` và báo kết quả nguyên văn (không báo xanh khi chưa chạy).
- Báo cáo cuối: danh sách file tạo ra và đã xóa, bảng đã chạy / chưa chạy, câu hỏi còn mở.

### Quy tắc git
- Tạo **nhánh mới từ `main`** (ví dụ `docs/nodejs-basics-course`), commit theo từng bước có nghĩa (xóa cũ; đề cương; mỗi ngày; kiểm chứng), push nhánh đó. **Không** mở pull request khi chưa được yêu cầu. Không commit hay push khi chưa được phép trong phiên.

### Tiêu chí hoàn thành
- Người học làm được các bài của Ngày 1-3 **mà không cần đọc lời giải**, và nói được bằng lời thường vì sao `async/await` không chặn chương trình.
- Người học dựng được một API nhỏ có test (Ngày 4-6) tự gõ từng dòng, và xử lý được trường hợp trùng, timeout, retry.
- Ngày 7: người học chạy được test của dự án, đặt breakpoint trong luồng đã chọn, kể lại luồng đó theo đúng thứ tự hàm được gọi (có `file:dòng`).
- Mọi bài tập có starter đỏ đúng chỗ, lời giải xanh, và đã được chạy thật; chỗ chưa chạy được ghi rõ.
