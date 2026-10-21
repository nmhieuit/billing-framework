# Giáo trình Node.js 7 ngày: từ con số không đến đọc được luồng thật của `billing-framework`

Dành cho một **software manager** biết lập trình căn bản và biết thiết kế hệ thống ở mức khái niệm, **chưa từng viết Node.js**. Học bằng cách **gõ code từng dòng, chạy, sửa lỗi** và làm các bài tập nhỏ tăng dần độ khó. Sáu ngày đầu dùng ví dụ tự dựng, ngày thứ bảy mới đụng tới code thật của dự án.

- Ngôn ngữ: tiếng Việt; thuật ngữ giữ tiếng Anh kèm giải thích (xem [`thuat-ngu.md`](thuat-ngu.md)).
- Môi trường: Windows, VS Code, PowerShell. Docker chỉ là phần **tùy chọn** ở cuối Ngày 7.
- Thời lượng: 7 ngày × 4 giờ.
- Quy ước làm việc với người biên soạn: **hỏi lại, không suy diễn**. Chỗ nào chưa chắc đều được đánh dấu **[CHƯA CHẠY]** (chưa chạy thử) hoặc **[GIẢ THUYẾT]**.

## Lộ trình

| Ngày | Bài học | Bạn làm được gì | Bài tập |
| ---- | ------- | ---------------- | ------- |
| 1 | [JavaScript căn bản](ngay-1-javascript-can-ban.md) | Chạy file bằng `node`, đọc lỗi, biến, hàm, mảng, vòng lặp, đối tượng | 8 |
| 2 | [Hàm bậc cao, module, TypeScript](ngay-2-ham-module-typescript.md) | `map` / `filter` / `reduce`, `import` / `export`, kiểu, `class`, viết test đầu tiên | 8 |
| 3 | [Bất đồng bộ](ngay-3-bat-dong-bo.md) | `Promise`, `async/await`, thứ tự chạy, song song, file, việc chạy nền an toàn | 9 |
| 4 | [HTTP API đầu tiên](ngay-4-http-api-dau-tien.md) | Server Fastify, `GET` / `POST`, mã trạng thái, kiểm tra đầu vào, test bằng `inject`, hook | 9 |
| 5 | [Dữ liệu, tách lớp, chống trùng](ngay-5-du-lieu-tach-lop-chong-trung.md) | Tiền số nguyên, repository / service / HTTP, `Idempotency-Key`, race condition | 10 |
| 6 | [Độ tin cậy và debug](ngay-6-do-tin-cay-va-debug.md) | `fetch` + timeout, thử lại theo bậc, máy trạng thái, chạy nền, webhook, debugger VS Code | 10 |
| 7 | [Hai luồng thật của dự án](ngay-7-luong-that-cua-du-an.md) | Đọc, chạy, debug `GET /wallet` và `POST /topups`; viết test cho code thật | 6 |

Phụ lục: [thuật ngữ](thuat-ngu.md) · [sổ tay lệnh PowerShell](so-tay-lenh.md).

## Điều kiện tiên quyết

- Biết khái niệm biến, hàm, vòng lặp, điều kiện, cấu trúc dữ liệu cơ bản (từ bất kỳ ngôn ngữ nào) và khái niệm service / API / database / queue ở mức hệ thống.
- Đã cài: Node.js 22, VS Code, Git. Docker Desktop chỉ cần cho phần tùy chọn Ngày 7.
- Không cần biết trước JavaScript, TypeScript hay Node.

## Cách học mỗi ngày

Mỗi ngày gồm các **khối ≤ 55 phút**, mỗi khối kết thúc bằng một việc bạn **chạy được và thấy kết quả**:

1. Đọc mục tiêu, làm phần "Chuẩn bị".
2. Với mỗi khối: đọc khái niệm → **gõ lại** ví dụ vào `node-training/hoc/dayN/` (không dán) → **đoán** kết quả → chạy → so sánh → đổi một chỗ nhỏ rồi chạy lại.
3. Làm bài tập của khối ngay sau khi học xong khối đó (mỗi bài ghi mức **Cơ bản / Trung bình / Nâng cao / Sửa lỗi** và thời gian gợi ý).
4. Cuối ngày: làm bài kiểm tra ngắn, đối chiếu đáp án, đánh dấu checklist.

## Cách tự chấm bài

Mỗi bài tập có một file test cùng tên. Từ thư mục `node-training`:

```bash
pnpm test day1/ex01        # một bài
pnpm test day1             # cả ngày
```

- **Đỏ** (có `FAIL`) = chưa đạt. Đọc `expected` (kỳ vọng) và `Received` (nhận được) để biết còn sai chỗ nào.
- **Xanh** = đạt.
- Ban đầu mọi bài đều **đỏ** (đó là điều đúng: chưa ai làm). Nhiệm vụ của bạn là biến chúng thành xanh.
- Gợi ý có 3 mức, mở dần từng mức (cuối mỗi bài học). Lời giải nằm riêng ở `node-training/solutions/dayN/`, chỉ mở sau khi đã thử và dùng hết gợi ý.
- Bài tiêu chí khác (ví dụ Ngày 2 bài 7 cần `pnpm check`) được ghi rõ trong bảng "Danh sách bài tập" của ngày đó.

## Bố cục thư mục

```text
docs/training/nodejs-1-tuan/      tài liệu này
  README.md, ngay-1..7-*.md, thuat-ngu.md, so-tay-lenh.md
  diagrams/                       hai sơ đồ draw.io (dùng ở Ngày 7)
node-training/                    code bài tập, độc lập với phần còn lại của repo
  package.json, pnpm-workspace.yaml   riêng, không thuộc workspace của dự án
  day1/ ... day7/                 bài tập (starter có TODO + file test)
  solutions/day1/ ... day7/       lời giải, đặt riêng
  examples/day1/ ... day6/        file mẫu của các ví dụ trong bài học
  hoc/                            thư mục bạn tự tạo để gõ bài học (Git bỏ qua)
  scripts/verify.sh               dành cho người biên soạn: kiểm tra starter đỏ, lời giải xanh
```

`node-training/` được cấu hình để `typecheck`, `lint`, `test`, `prettier`, Docker build và SonarQube của dự án **bỏ qua** nó (xem thay đổi ở `tsconfig.json`, `eslint.config.js`, `vitest.config.ts`, `.prettierignore`, `.dockerignore`), nên các bài tập đang đỏ không làm CI của dự án đỏ.

## Cài đặt một lần

```bash
cd node-training
corepack enable
pnpm install
```

Chi tiết và cách xử lý khi `pnpm` không chạy: xem "Chuẩn bị" của [Ngày 1](ngay-1-javascript-can-ban.md).

## Cách xin hỗ trợ khi bị kẹt

Khi hỏi, đính kèm để người khác tái hiện được ngay:

1. Bạn đang làm bài nào (`day3/ex05`), ở thư mục nào.
2. Lệnh bạn đã chạy.
3. **Nguyên văn** thông báo lỗi (sao chép chữ, đừng chụp một phần).
4. File và dòng bạn nghi ngờ, kèm đoạn code đang có.
5. Kết quả của `node --version` và `pnpm --version`.

## Bảng đã chạy / chưa chạy

Người biên soạn chạy trên **Linux, Node v22.22.0, pnpm 9.15.9, vitest 5.0.3, tsx 4.23.15, TypeScript 5.9.3, Fastify 5.12.5** (đúng phiên bản của repo). Môi trường biên soạn **không có Windows, VS Code giao diện, Docker**.

| Hạng mục | Trạng thái | Ghi chú |
| -------- | ---------- | ------- |
| Mọi ví dụ trong Ngày 1-6 (`examples/`) | **Đã chạy** | Đầu ra trong sách là đầu ra thật (đường dẫn được rút gọn thành `C:/node-training/hoc/...`); số mili-giây có thể lệch vài đơn vị |
| Server và `curl` ở Ngày 4, 5 | **Đã chạy** | Dùng `curl` trên Linux; cú pháp `curl.exe` và `-d "@file"` trên PowerShell **[CHƯA CHẠY]** |
| 54 file test bài tập Ngày 1-6 | **Đã chạy** | Mỗi bài: starter có ít nhất một test đỏ, lời giải xanh toàn bộ (bảng bên dưới) |
| Mẫu test Ngày 7 (2 file) | **Đã chạy** | Starter đỏ, lời giải xanh; "phá code" làm test đỏ; đã hoàn tác (`git status` sạch) |
| 5 file test đơn vị của wallet dùng ở Ngày 7 | **Đã chạy** | `59 passed`; toàn bộ `corepack pnpm test` của repo: `1034 passed` |
| Cấu hình CI bỏ qua `node-training/` | **Đã chạy** | `typecheck`, `lint`, `format:check`, `test` đều xanh sau khi thêm thư mục này |
| Lệnh `node --import tsx`, `vitest ... --pool=forks`, Node mở cổng `--inspect-brk` (cấu hình debug Ngày 6) | **Đã chạy** | Chạy được trên Linux |
| Đặt breakpoint và dừng thực sự trong giao diện VS Code | **[CHƯA CHẠY]** | Cần VS Code giao diện |
| Mọi lệnh PowerShell / Windows (`corepack enable`, `mkdir hoc\day1`, `Copy-Item`, `Remove-Item`) | **[CHƯA CHẠY]** | Môi trường biên soạn là Linux |
| Phần Docker tùy chọn Ngày 7 | **[CHƯA CHẠY]** | Trích từ tài liệu có sẵn của repo |
| Đáp án các bài kiểm tra cuối ngày | Do người biên soạn suy ra từ nội dung bài | Không có test tự động |

### Kết quả từng bài tập (Ngày 1-6)

Mỗi dòng: số test **xanh / đỏ / chưa viết (todo)** ở trạng thái ban đầu (starter), rồi số test **xanh / đỏ** khi dùng lời giải.

| Test | Starter: xanh / đỏ / todo | Lời giải: xanh / đỏ |
| ---- | ------------------------ | ------------------- |
| `day1/ex01-greet.test.js` | 0 / 2 / 0 | 2 / 0 |
| `day1/ex02-is-even.test.js` | 0 / 2 / 0 | 2 / 0 |
| `day1/ex03-sum-max.test.js` | 0 / 2 / 0 | 2 / 0 |
| `day1/ex04-count-words.test.js` | 0 / 3 / 0 | 3 / 0 |
| `day1/ex05-wallet.test.js` | 0 / 3 / 0 | 3 / 0 |
| `day1/ex06-totals.test.js` | 0 / 3 / 0 | 3 / 0 |
| `day1/ex07-bug-average.test.js` | 1 / 1 / 0 | 2 / 0 |
| `day1/ex08-bug-add-amounts.test.js` | 1 / 2 / 0 | 3 / 0 |
| `day2/ex01-double-all.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day2/ex02-only-deposits.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day2/ex03-balance.test.ts` | 0 / 3 / 0 | 3 / 0 |
| `day2/ex04-format-transaction.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day2/ex05-summary.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day2/ex06-wallet.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day2/ex07-bug-types.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day2/ex08-discount.test.ts` | 0 / 1 / 5 | 6 / 0 |
| `day3/ex01-predict.test.ts` | 0 / 1 / 0 | 1 / 0 |
| `day3/ex02-sleep.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day3/ex03-predict.test.ts` | 0 / 1 / 0 | 1 / 0 |
| `day3/ex04-safe-divide.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day3/ex05-sequential-parallel.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day3/ex06-wallet-file.test.ts` | 1 / 2 / 0 | 3 / 0 |
| `day3/ex07-fire-and-forget.test.ts` | 0 / 3 / 0 | 3 / 0 |
| `day3/ex08-bug-foreach.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day3/ex09-bug-try-catch.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day4/ex01-health.test.ts` | 0 / 1 / 0 | 1 / 0 |
| `day4/ex02-hello.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day4/ex03-create-wallet.test.ts` | 0 / 5 / 0 | 5 / 0 |
| `day4/ex04-get-wallet.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day4/ex05-header.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day4/ex06-deposit.test.ts` | 1 / 6 / 0 | 7 / 0 |
| `day4/ex07-request-log.test.ts` | 0 / 1 / 0 | 1 / 0 |
| `day4/ex08-bug-param.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day4/ex09-bug-late-route.test.ts` | 0 / 1 / 0 | 1 / 0 |
| `day5/ex01-cents.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day5/ex02-repository.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day5/ex03-service.test.ts` | 0 / 5 / 0 | 5 / 0 |
| `day5/ex04-http-layer.test.ts` | 1 / 4 / 0 | 5 / 0 |
| `day5/ex05-idempotency-store.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day5/ex06-topup-endpoint.test.ts` | 0 / 9 / 0 | 9 / 0 |
| `day5/ex07-concurrent.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day5/ex08-ledger.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day5/ex09-bug-key-type.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day5/ex10-bug-save-too-early.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day6/ex01-call-payment.test.ts` | 0 / 2 / 0 | 2 / 0 |
| `day6/ex02-gateway.test.ts` | 3 / 2 / 0 | 5 / 0 |
| `day6/ex03-retry.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day6/ex04-submit-with-retry.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day6/ex05-topup-state.test.ts` | 1 / 3 / 0 | 4 / 0 |
| `day6/ex06-background-submit.test.ts` | 0 / 4 / 0 | 4 / 0 |
| `day6/ex07-webhook.test.ts` | 0 / 7 / 0 | 7 / 0 |
| `day6/ex08-bug-retry-count.test.ts` | 0 / 3 / 0 | 3 / 0 |
| `day6/ex09-bug-no-timeout.test.ts` | 1 / 1 / 0 | 2 / 0 |
| `day6/ex10-bug-hunt.test.ts` | 1 / 3 / 0 | 4 / 0 |

Tổng cộng 54 file test, 166 test. Một số bài có test xanh ngay ở starter (ví dụ bài sửa lỗi có một phần đã đúng) vì bài chỉ đỏ ở chỗ lỗi; điều kiện kiểm tra là **mỗi bài có ít nhất một test đỏ**.

## Những điều giáo trình này không bao gồm

- Kiến trúc đầy đủ của dự án (NestJS, DI container, bộ nối RabbitMQ, outbox, đối soát, công cụ vận hành). Ngày 7 chỉ đọc đủ để lần theo hai luồng.
- `process.nextTick`, `setImmediate`, event loop chi tiết (chỉ giới thiệu microtask và macrotask ở Ngày 3).
- Các luồng thật khác của dự án; chọn luồng nào học tiếp là quyết định của bạn.

## Câu hỏi còn mở

- Các lệnh Windows / PowerShell ở trên chưa được chạy thử trên máy Windows.
- Hai file draw.io trong `diagrams/` có ghi chú nhắc tới các bài lab của giáo trình cũ đã bị xóa; nội dung lab vẫn nằm trong lịch sử git. Có cần cập nhật ghi chú trong hai file đó không?
