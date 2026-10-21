# Bảng thuật ngữ

Cột "Ngày" là nơi thuật ngữ được giải thích lần đầu. Thuật ngữ giữ tiếng Anh vì bạn sẽ gặp đúng chữ đó trong code, lỗi và tài liệu.

| Thuật ngữ | Giải thích ngắn | Ngày |
| --------- | ---------------- | ---- |
| API | Giao diện để chương trình này gọi chương trình khác; ở đây là các route HTTP | 4 |
| arrow function (hàm mũi tên) | Cách viết hàm ngắn: `(x) => x * 2` | 2 |
| async / await | Cách viết code bất đồng bộ trông như tuần tự; `await` tạm dừng hàm chứa nó cho tới khi Promise xong | 3 |
| asynchronous (bất đồng bộ) | Hẹn việc, làm việc khác, được báo khi xong; không đứng chờ | 3 |
| backoff | Chờ lâu dần giữa các lần thử lại (1s, 5s, 30s...) | 6 |
| body | Phần nội dung của request / response (thường là JSON) | 4 |
| breakpoint | Điểm đặt trên một dòng code để debugger dừng chương trình tại đó | 6 |
| callback | Hàm truyền cho nơi khác để được gọi lại sau | 3 |
| class | Khuôn tạo nhiều đối tượng cùng loại có dữ liệu và hành vi riêng | 2 |
| `const` / `let` | Khai báo biến: `const` không gán lại được, `let` gán lại được | 1 |
| correlation id | Mã gắn vào một request để lần theo nó qua nhiều service (chỉ nhắc ở Ngày 7) | 7 |
| `curl` / `curl.exe` | Công cụ dòng lệnh gọi HTTP; trên PowerShell gõ `curl.exe` | 4 |
| debugger | Công cụ dừng chương trình ở breakpoint, bước từng dòng, xem biến | 6 |
| dependency injection (tiêm phụ thuộc) | Đưa thứ lớp cần dùng vào từ bên ngoài (qua constructor) thay vì tự tạo | 5 |
| destructuring | Tách nhanh thuộc tính: `const { type, amount } = tx` | 2 |
| domain | Lớp chứa quy tắc nghiệp vụ thuần túy, không biết HTTP hay database | 7 |
| drain | Chờ các việc nền đang chạy xong, dùng khi tắt dịch vụ | 6 |
| `export` / `import` | Chia sẻ và nhận hàm, hằng số giữa các file | 2 |
| Fastify | Thư viện web của Node dùng trong wallet và payment | 4 |
| `fetch` | Hàm gọi HTTP từ code | 6 |
| fingerprint | Chuỗi đại diện cho nội dung yêu cầu (ví dụ băm SHA-256), để phát hiện cùng khóa mà khác nội dung | 5 |
| fire-and-forget | Chạy việc nền mà không chờ kết quả (luôn cần `.catch`) | 3 |
| handler | Hàm xử lý một route | 4 |
| header | Thông tin kèm theo request / response ngoài body (ví dụ `x-customer-id`) | 4 |
| hook | Đoạn code chạy ở một thời điểm cố định của vòng đời request (ví dụ `onResponse`) | 4 |
| idempotent / Idempotency-Key | Làm nhiều lần cũng như một lần; header giúp server nhận ra yêu cầu gửi lại | 5 |
| `inject` | Cách của Fastify đưa một request giả vào ứng dụng trong bộ nhớ để test | 4 |
| inbox | Bảng ghi các `eventId` đã xử lý để loại webhook trùng | 7 |
| interface (TypeScript) | Mô tả hình dạng của một đối tượng | 2 |
| `instanceof` | Kiểm tra một đối tượng có thuộc một lớp (ví dụ một loại lỗi) hay không | 5 |
| JSON | Định dạng văn bản mô tả dữ liệu: `{"owner":"An"}` | 3 |
| `Map` | Kho khóa → giá trị trong bộ nhớ: `set`, `get`, `size` | 4 |
| Kysely | Thư viện viết truy vấn SQL bằng TypeScript, dùng trong dự án | 7 |
| ledger (sổ cái) | Sổ ghi mọi biến động tiền; ghi sổ kép = mỗi lần ghi tổng bằng 0 | 5 |
| lease | Quyền "giữ chỗ" tạm thời một lệnh để gửi đi; hết hạn thì lệnh tự đến hạn lại | 7 |
| macrotask | Việc đã hẹn bằng `setTimeout`; chạy sau mọi microtask | 3 |
| microtask | Việc `.then` / phần sau `await` của Promise đã xong; chạy trước macrotask | 3 |
| module | Một file JavaScript / TypeScript có `export` / `import` | 2 |
| monorepo | Một repo chứa nhiều dự án con (wallet, payment, packages) | 7 |
| NestJS | Khung ứng dụng web chạy trên Fastify, dùng trong wallet | 7 |
| Node.js (Node) | Chương trình chạy JavaScript ngoài trình duyệt | 1 |
| outbox | Mẫu thiết kế gửi message đáng tin cậy (chỉ nhắc, không học trong tuần này) | 7 |
| payment | Dịch vụ thanh toán giả lập cổng thanh toán trong dự án | 6 |
| pnpm | Trình quản lý gói của dự án; chạy qua `corepack` | 1 |
| Promise | Đối tượng đại diện cho kết quả sẽ có (thành công `resolve` hoặc thất bại `reject`) | 3 |
| regular expression (biểu thức chính quy) | Mẫu để kiểm tra chuỗi, ví dụ `/^\d+$/` | 5 |
| race condition | Hai việc chạy đan xen gây kết quả sai | 5 |
| rejected | Kết quả gọi payment bị từ chối (4xx), thử lại vô ích | 6 |
| repository | Lớp chuyên lưu và đọc dữ liệu | 5 |
| request / response | Yêu cầu gửi tới server / phản hồi server trả về | 4 |
| retry | Thử lại khi thất bại | 6 |
| route | Cặp phương thức + đường dẫn mà server xử lý (`GET /health`) | 4 |
| service (lớp nghiệp vụ) | Lớp chứa quy tắc nghiệp vụ, điều phối repository | 5 |
| spread (`...`) | Chép từng thuộc tính của một đối tượng sang đối tượng mới: `{ ...wallet }` | 5 |
| stack trace | Chuỗi các nơi dẫn tới lỗi, in kèm thông báo lỗi | 1 |
| state machine (máy trạng thái) | Mô hình các trạng thái và các chuyển tiếp hợp lệ giữa chúng | 6 |
| status code (mã trạng thái) | Số 3 chữ số của response: 200, 201, 202, 400, 401, 404, 422, 500... | 4 |
| template string | Chuỗi trong dấu huyền chèn giá trị bằng `${...}` | 1 |
| tenant | Một khách hàng doanh nghiệp trong hệ thống nhiều khách hàng; mỗi tenant có dữ liệu riêng | 7 |
| timeout | Giới hạn thời gian chờ; quá hạn thì hủy | 6 |
| topup | Lệnh nạp tiền vào ví | 6 |
| `tsx` | Công cụ chạy trực tiếp file TypeScript | 2 |
| TypeScript | JavaScript có thêm kiểu dữ liệu để bắt lỗi trước khi chạy | 2 |
| unhandled rejection | Promise thất bại mà không ai bắt lỗi; mặc định làm sập chương trình Node | 3 |
| unavailable | Kết quả gọi payment là tạm thời không dùng được (chậm, lỗi mạng, 5xx), thử lại được | 6 |
| unit of work (`uow`) | Gói các thao tác lưu trữ vào cùng một giao dịch cơ sở dữ liệu | 7 |
| vitest | Công cụ chạy test của dự án | 2 |
| webhook | Dịch vụ khác chủ động gọi HTTP ngược lại để báo kết quả | 6 |
