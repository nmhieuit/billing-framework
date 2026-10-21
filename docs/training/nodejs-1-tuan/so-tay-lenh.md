# Sổ tay lệnh (PowerShell)

Các lệnh dưới đây viết cho **PowerShell** trên Windows và cũng chạy được trên Linux / macOS, trừ khi ghi chú khác. Môi trường biên soạn là Linux nên các lệnh dành riêng cho Windows ghi **[CHƯA CHẠY]**.

## Kiểm tra môi trường

| Lệnh | Làm gì |
| ---- | ------ |
| `node --version` | Phiên bản Node (cần `v22.x`) |
| `corepack enable` | Bật `corepack` để dùng `pnpm` đúng phiên bản của dự án (có thể cần chạy PowerShell bằng quyền Administrator một lần) **[CHƯA CHẠY trên Windows]** |
| `pnpm --version` | Phiên bản pnpm. Nếu không nhận lệnh, thêm `corepack` đứng trước mọi lệnh pnpm: `corepack pnpm --version` |

## Chạy code

| Lệnh | Làm gì |
| ---- | ------ |
| `node hoc/day1/a-hello.js` | Chạy file JavaScript |
| `pnpm tsx hoc/day2/c-types.ts` | Chạy file TypeScript (không kiểm tra kiểu) |
| `pnpm check hoc/day2/c-types.ts` | Kiểm tra kiểu một file TypeScript (không chạy) |

## Test (trong `node-training`)

| Lệnh | Làm gì |
| ---- | ------ |
| `pnpm test` | Chạy mọi bài tập (lúc đầu hầu hết đỏ) |
| `pnpm test day3` | Chạy mọi bài của Ngày 3 |
| `pnpm test day3/ex05` | Chạy một bài |
| `pnpm test hoc/day2` | Chạy các test bạn tự viết trong `hoc/day2` |
| `pnpm test:watch` | Chạy lại test mỗi khi bạn lưu file |

## Gọi HTTP

| Lệnh | Làm gì |
| ---- | ------ |
| `curl.exe -i http://localhost:3000/health` | `GET`, hiện cả header (`-i`) |
| `curl.exe -i -X POST http://localhost:3000/wallets -H "content-type: application/json" -d "@hoc/day4/body.json"` | `POST` với body đọc từ file (tránh rắc rối dấu nháy) **[CHƯA CHẠY trên Windows]** |
| `curl.exe -H "idempotency-key: k1" ...` | Thêm một header |

Luôn gõ `curl.exe` trên PowerShell: `curl` là bí danh của một lệnh khác.

## Thư mục và file (PowerShell)

| Lệnh | Làm gì |
| ---- | ------ |
| `mkdir hoc\day1` | Tạo thư mục (Linux / macOS: `mkdir -p hoc/day1`) **[CHƯA CHẠY trên Windows]** |
| `pwd` | Thư mục hiện tại |
| `code .` | Mở thư mục hiện tại bằng VS Code |
| `Copy-Item a b` | Sao chép file (Linux / macOS: `cp a b`) **[CHƯA CHẠY trên Windows]** |
| `Remove-Item a` | Xóa file (Linux / macOS: `rm a`) **[CHƯA CHẠY trên Windows]** |

## Git (Ngày 7)

| Lệnh | Làm gì |
| ---- | ------ |
| `git switch -c hoc/ngay-7` | Tạo và chuyển sang nhánh học |
| `git status` | Xem file nào đã đổi / mới |
| `git checkout <file>` hoặc `git restore <file>` | Hoàn tác thay đổi trong một file đã có |
| `git switch -` | Quay lại nhánh trước |

## Test của dự án (thư mục gốc repo)

| Lệnh | Làm gì |
| ---- | ------ |
| `corepack pnpm install` | Cài thư viện của cả monorepo |
| `corepack pnpm test` | Chạy mọi test đơn vị (không cần Docker) |
| `corepack pnpm vitest run <đường dẫn file>` | Chạy một hoặc vài file test |
| `corepack pnpm typecheck` | Kiểm tra kiểu toàn repo |
| `corepack pnpm lint` | Kiểm tra quy tắc code |
| `corepack pnpm format:check` | Kiểm tra định dạng |

## Docker (chỉ phần tùy chọn Ngày 7) **[CHƯA CHẠY]**

| Lệnh | Làm gì |
| ---- | ------ |
| `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d --build` | Dựng cả hệ thống |
| `docker compose -f deploy/compose.local.yml --env-file deploy/.env ps -a` | Xem trạng thái các container |
| `docker compose -f deploy/compose.local.yml --env-file deploy/.env logs wallet payment` | Xem log của wallet và payment |
| `docker compose -f deploy/compose.local.yml --env-file deploy/.env down` | Dừng và dọn |
