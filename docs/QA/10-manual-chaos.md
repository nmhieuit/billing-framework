# Chaos: kiểm tra lại và kế hoạch test manual

> **Giai đoạn 2, nhóm chaos.** Nhánh `main` vừa nhận bộ **chaos test** (`tests/chaos`, PR `feature/chaos-tests`, commit `e5d5034` trở về trước) và bản Postman mock (PR `docs/postman-mock`). Tài liệu này (1) kiểm tra lại những gì chaos thay đổi, (2) ánh xạ các kịch bản chaos tự động sang việc test **manual** trên local stack, (3) trỏ tới collection Postman chaos (`11-postman-chaos.md`).
> Nguồn: `docs/ops/chaos-testing.vi.md`, `docs/ops/chaos-findings.vi.md`, `docs/adr/0014-chaos-tests-in-process-and-child.vi.md`, mã trong `tests/chaos`, và `git diff 5f85815..origin/main`.
> **Chưa chạy `corepack pnpm test:chaos`**: bộ này cần Docker (testcontainers), mà container làm việc không có Docker. Mọi kết quả "đạt/không phát hiện lỗi" dưới đây là **lời của tài liệu chaos**, chưa được tôi kiểm lại bằng cách chạy.

## 1. Chaos test là gì (đủ để đọc phần sau)

- Bộ test tự động **cố ý làm hỏng** SQL Server, RabbitMQ, đường HTTP wallet↔payment và chính tiến trình dịch vụ, rồi kiểm tra **8 bất biến về tiền** (`INV-1..INV-8`) bằng một "oracle" dùng chung (`tests/chaos/support/invariants.ts`; `docs/ops/chaos-testing.vi.md:13`).
- Gồm 13 kịch bản xác định `S1..S13` (`chaos-testing.vi.md:169`), test công cụ, và bài soak ngẫu nhiên theo seed (`chaos-testing.vi.md:199`).
- Chạy trên **hạ tầng dựng riêng bằng testcontainers**, **không** dùng stack `billing-local`, và không nên trỏ vào môi trường dùng chung (`chaos-testing.vi.md:8`).
- Lệnh: `corepack pnpm test:chaos`, `corepack pnpm test:chaos:soak` (`package.json`, `README.md:71-72`).

## 2. Kiểm tra lại (đối chiếu với `main`)

| # | Kiểm tra | Kết quả | Dẫn chứng |
| --- | --- | --- | --- |
| 1 | Chaos có đổi API HTTP/contract của wallet, payment không? | **Không.** `git diff 5f85815 origin/main` trên `services/*/src/interface` và `packages/contracts` trống. Các collection Postman và test plan manual trước đó **không bị ảnh hưởng** | `git diff --stat` |
| 2 | Chaos đổi code production ở đâu? | Chỉ hai seam test-only, mặc định không làm gì: `createDatabase(config, { wrapDialect })`, `StartOverrides.wrapDialect` (wallet, payment) và `wrapPublisher` (wallet); thêm hàm `received()` ở `test-support-orders.ts` | `packages/database/src/connection.ts`, `services/wallet/src/bootstrap.ts`, `services/payment/src/bootstrap.ts`; ADR-0014 |
| 3 | Chaos có làm hỏng `pnpm test` mặc định không? | Cấu hình đã loại `*.chaos.test.ts` và `*.soak.test.ts` khỏi `vitest.config.ts`; các test thuần của công cụ (không cần Docker) vẫn chạy trong `pnpm test` | `vitest.config.ts` (diff), `chaos-testing.vi.md:73-75` |
| 4 | Chaos có nằm trong CI không? | **Không thấy.** `Jenkinsfile` không có từ khóa `chaos`; chỉ có script `test:chaos` trong `package.json` | `grep -i chaos Jenkinsfile` rỗng |
| 5 | Thời gian chạy | Tài liệu tự ghi **≈ 11-12 phút khi máy rảnh, tới ≈ 19 phút khi máy bận**, vượt mục tiêu < 10 phút của kế hoạch; đo trên máy Windows | `chaos-testing.vi.md:89-95` |
| 6 | Kết quả "không phát hiện lỗi sản phẩm nào" | **Chưa xác minh.** Đây là kết luận của tài liệu chaos (13 kịch bản và soak seed 1-5); tôi không chạy được bộ này | `chaos-findings.vi.md` |

### Quan sát và rủi ro rút ra khi đọc (không phải lỗi đã chứng minh)

1. **Chaos chưa chạy trong CI** (mục 4 ở trên): hồi quy về tiền có thể lọt qua mà không ai thấy. *Đề xuất:* cân nhắc một stage riêng, chạy theo lịch (ví dụ ban đêm), vì bộ mất 11-19 phút và cần Docker.
2. **"Xanh" chỉ chứng minh hội tụ cuối cùng, không chứng minh độ trễ thật.** `heal()` kéo backoff/lease về "đến hạn" (outbox, topup `REQUESTED`), nên không kiểm được các độ trễ production (backoff `1/5/30/120/600` s, lease 60 s, ngưỡng dọn lượt đối soát 30 phút); backoff webhook của harness là `[1, 2, 3]` giây thay vì `1,5,30,120,600` nên webhook hết lượt **sớm hơn** production (`chaos-testing.vi.md:252-259`). *Hệ quả cho QA:* độ trễ thật chỉ kiểm được **manual** (kịch bản `CHM-015` bên dưới).
3. **DB wallet của chaos bật `ALLOW_SNAPSHOT_ISOLATION ON`, production thì không**; INV-3 dựa vào đó (`chaos-testing.vi.md:260`). Nếu production không bật, oracle không kiểm được nguyên văn trên cấu hình production.
4. **Không có Orders thật, hạ tầng thật, Linux/macOS.** Orders là mô phỏng không tự nối lại; lỗi chỉ ở ranh giới ứng dụng (KILL session, đóng kết nối AMQP, proxy HTTP, `SIGKILL`); thời gian chỉ đo trên Windows (`chaos-testing.vi.md:275-290`).
5. **Chế độ `child` hẹp hơn:** không có lỗi dialect/publisher nên S1-S5, S11, S12 và vòng `child` của soak ít bao phủ hơn; retention thật chỉ ở `inproc` (`chaos-testing.vi.md:141-147`, `:277-282`).
6. **Ghi chú vận hành cần đưa vào runbook DLQ:** đơn **đã trả** vẫn có thể rơi vào `wallet.order-payments.dlq` (kịch bản S3). Trước khi xử lý message DLQ, kiểm `order_payments` theo `orderId`; phát lại là vô hại (`DUPLICATE`) (`chaos-findings.vi.md`, mục "Đơn ĐÃ trả vẫn có thể rơi vào DLQ"). Đã phản ánh ở case `DLQ-007` trong [`03-manual-order-payment.md`](03-manual-order-payment.md).
7. **Webhook hết lượt thì topup treo `PENDING` tới lần đối soát kế tiếp** (S7, S9): đã có case manual tương ứng ở `01` (LED-008), `05` (REC-032) và `CHM-015` bên dưới.

## 3. Ánh xạ kịch bản chaos sang test manual

"Manual được?" nghĩa là làm được trên **local stack** (`deploy/compose.local.yml`) bằng `docker compose`, RabbitMQ management, Postman; **không** thay được test tự động (không có `FaultPlan`, proxy, hook).

| Kịch bản | Điểm lỗi (tự động) | Manual được? | Cách làm trên local stack | Case |
| --- | --- | --- | --- | --- |
| S1, S2, S4 | KILL session ở một câu SQL cụ thể; consumer chết sau commit trước ack; publish xong mất ack | **Không** (cần chính xác tới câu lệnh/commit) | Chỉ bộ tự động | (tự động) |
| S2b | Cùng `orderId`, `eventId` mới | **Có** (đã có) | Publish tay qua RabbitMQ | `ORD-002` trong `03` |
| S3 | Consumer chết sau commit nhiều lần, message vào DLQ dù đã trả | **Không dựng được**; nhưng **kiểm được hệ quả** | Đọc `order_payments` trước khi xử lý DLQ | `DLQ-007` trong `03` |
| S3c, S5 | Cắt kết nối AMQP của wallet khi đang xử lý | **Có** | RabbitMQ management → Connections → đóng kết nối của `billing_wallet` | `CHM-016` |
| S6a/b/c | Lỗi/trễ/mất phản hồi đường wallet→payment | **Một phần** | `docker compose pause payment` rồi `unpause` khi đang nạp tiền | `CHM-010` |
| S7 | Mọi webhook bị mất (hết lượt) | **Có** (lâu ≈ 13 phút) | Dừng wallet > 756 s | `CHM-015` |
| S8a/b | Webhook trùng/đến muộn | **Có** | Webhook ký tay | `WHK-010` (`01`), `CHR-04` (Postman) |
| S9 | `SIGKILL` wallet giữa lúc gửi sang payment | **Có** (cần timing) | `docker kill wallet` ngay sau `POST /topups` | `CHM-013` |
| S10 | `SIGKILL` payment sau khi charge `SUCCEEDED`, trước khi giao webhook | **Có** (cần timing; nên tăng `WORKER_INTERVAL_MS`) | `docker kill payment` | `CHM-014` |
| S11 | KILL session giữa thao tác ops | **Không** (timing) | Bộ tự động; retry cùng khóa kiểm bằng Postman | `CHR-02`, `CHR-03` |
| S12 | KILL giữa lô retention thật | **Không** | Bộ tự động | (tự động) |
| S13 | KILL mọi session khi hệ rảnh | **Có** nếu có quyền SQL | T-SQL `KILL` các session của hai DB | `CHM-018` |
| Soak | Tải ngẫu nhiên + lỗi ngẫu nhiên | **Một phần** | Postman `Workload` nhiều lượt lặp + tiêm lỗi tay | `CHM-019` |
| INV-1..8 | Oracle | **Có (bản nhẹ)** qua HTTP | Postman folder `Oracle` | `CHM-002` và mọi `CHM-01x` |

## 4. Quy trình chung cho một lượt chaos manual

1. **Stack khỏe và sạch lỗi:** `GET /health` hai service, các job `*-init`, `migrate` thoát mã 0 (`docs/ops/local-stack.vi.md`).
2. **Postman `Chaos / Smoke`** (chạy 1 lượt): dựng 4 ví ở 2 tenant, một topup nền, oracle-lite sạch (`CHM-001`, `CHM-002`).
3. **Postman `Chaos / Workload`** với số lượt lặp đủ lớn (ví dụ 30-60), **trong lúc đó** tiêm lỗi bằng lệnh của từng case.
4. **Gỡ lỗi** (`unpause`, `start`...) và chờ hệ yên.
5. **Postman `Chaos / Oracle`** (`ORC-00..06`): chờ yên, kiểm INV-1/3/8, ops (INV-6/7), đối soát hội tụ (INV-5), kiểm chặt lại.
6. Ghi kết quả; nếu có vi phạm, **lưu log** `docker compose ... logs wallet payment` và đầu ra của Postman.

Lưu ý an toàn: chỉ làm trên **local stack** (dữ liệu thử). Mọi lệnh `docker` bên dưới là **ví dụ chưa chạy**; kiểm tên service trong `deploy/compose.local.yml` trước khi dùng (`wallet`, `payment`, `rabbitmq`, `sqlserver`).

## 5. Danh sách test case manual

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất. "Truy vết" trỏ về kịch bản `S#`/bất biến `INV-#` của chaos.

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CHM-001 | Preflight trước chaos | Stack lên | Chạy Postman `Chaos / Smoke` (CHS-01..08) | Hai service `ok`; 4 ví tạo `201`; topup nền `SUCCEEDED` | P1 | S | INV-8 |
| CHM-002 | Oracle sạch trên hệ khỏe | Sau CHM-001 | Chạy `CHS-09` | Không vi phạm INV-1, INV-3, INV-8 | P1 | S | INV-1, 3, 8 |
| CHM-003 | An toàn khi gửi lại/trùng/muộn (không tiêm lỗi) | Sau CHM-001; `webhook_secret` đã đặt | Chạy `Chaos / Regression` (CHR-01..05) | Gửi lại cùng khóa ×3 cho cùng kết quả và **một** hiệu ứng; webhook trùng/muộn không ghi có lần hai; đối soát hai lần hội tụ | P1 | R | S2, S6, S8, S11; INV-3, 5, 6 |
| CHM-010 | Payment tạm đóng băng giữa tải | Sau CHM-001 | (1) Bắt đầu `Workload` ≥ 30 lượt; (2) `docker compose -f deploy/compose.local.yml --env-file deploy/.env pause payment` khoảng 15 s rồi `unpause`; (3) chờ hết Workload; (4) chạy `Oracle` | Workload không có 4xx bất ngờ (chỉ 5xx/chậm tạm thời, gửi lại cùng khóa); Oracle sạch; mỗi topup đã xác nhận chỉ cộng **một lần** | P1 | R | S6a/b/c; INV-3 |
| CHM-011 | Wallet tạm đóng băng giữa tải (webhook đến chậm) | Sau CHM-001 | Như CHM-010 nhưng `pause wallet` 15-20 s | Webhook payment gửi lại theo backoff, topup về `SUCCEEDED`; Oracle sạch (cần chờ ≤ vài phút do backoff `1,5,30,...`) | P1 | R | S7 (ngắn), S8; INV-3 |
| CHM-012 | Khởi động lại êm (graceful) giữa tải | Sau CHM-001 | `Workload`; `docker compose ... restart wallet` rồi `restart payment` (lần lượt) | Sau khi lên lại, Oracle sạch; không `5xx` kéo dài | P2 | R | S13; INV-8 |
| CHM-013 | `SIGKILL` wallet giữa lúc gửi sang payment | Sau CHM-001 | (1) `POST /topups` (Postman `WLD-01` hoặc `curl`); (2) **ngay lập tức** `docker compose ... kill wallet`; (3) `start wallet`; (4) chờ tới ≈ 60-90 s (lease 60 s) | Topup về `SUCCEEDED`; payment vẫn **một** charge cho `reference` đó; ví cộng **một** lần; Oracle sạch | P1 | R | S9; INV-3, 8 |
| CHM-014 | `SIGKILL` payment trước khi giao webhook | Nên đặt `PAYMENT_WORKER_INTERVAL_MS=20000` trong `deploy/.env` (mục 6) để có cửa sổ | (1) Tạo topup; (2) khi topup `PENDING`, `kill payment` trước tick hoàn tất; (3) `start payment`; (4) chờ | Webhook được giao sau khi payment dựng lại (số lần thử tăng); ví cộng **một** lần; Oracle sạch | P2 | R | S10; INV-3, 8 |
| CHM-015 | Webhook hết lượt: topup treo `PENDING`, đối soát sửa | Sau CHM-001; đặt `chaos_expect_missing_at_wallet=true` | (1) tạo một topup (Postman `WLD-01`); (2) khi topup chuyển `PENDING` (đã gửi sang payment) thì `stop wallet` **ngay** (nên tăng `PAYMENT_WORKER_INTERVAL_MS` như CHM-014); (3) giữ wallet dừng > 756 s (tổng backoff webhook `1,5,30,120,600`); (4) `start wallet`; (5) chạy `ORC-00..ORC-02`, rồi `ORC-05`, `ORC-06` | Trước đối soát: topup `PENDING` nhưng charge `SUCCEEDED` (chỉ `MISSING_AT_WALLET`); `ORC-05` ghi bù đúng một lần (`AUTO_APPLIED`); `ORC-06` sạch; ví cộng **một** lần | P1 | R | S7; INV-3, 5 |
| CHM-016 | Cắt kết nối AMQP của wallet khi xử lý order | Sau CHM-001; queue nhận kết quả đã tạo (`03`, mục 2) | (1) Publish 10 order (xem `03`); (2) RabbitMQ management → Connections → đóng kết nối của `billing_wallet` **hai lần** trong lúc xử lý | Cả 10 order trả **đúng một lần**; không có message mất; không vào DLQ (có thể có giao lại) | P1 | R | S3c, S5; INV-2, 4 |
| CHM-018 | KILL mọi session SQL khi hệ rảnh (cần quyền SQL) | Có `sqlcmd`/SQL ghi (đã được cấp quyền) | KILL các session của `billing_wallet` và `billing_payment`; ngay sau đó `GET /wallet` và `POST /topups` | Request kế tiếp **thành công ngay lần đầu** (pool thay session chết thầm lặng) | P3 | R | S13; INV-8 |
| CHM-019 | Tải dài + lỗi ngẫu nhiên bằng tay | Sau CHM-001 | `Workload` ≥ 200 lượt; xen kẽ `pause/unpause` và `restart` ngẫu nhiên hai service | Oracle sạch sau khi hết lỗi; thống kê tải có thao tác thành công (`WLD-04`) | P2 | R | Soak |
| CHM-020 | Test công cụ chaos không cần Docker | Có thể `pnpm install` | `corepack pnpm test` (gồm `prng`, `fault-plan`, `quiesce`, proxy HTTP...) | Xanh | P3 | R | tool tests |
| CHM-021 | Bộ chaos tự động | Có Docker | `corepack pnpm test:chaos` | 147 test xanh theo tài liệu (≈ 11-19 phút) | P2 | R | S1-S13 |

**Phân loại:** manual (CHM-001..019) kiểm **hành vi và độ trễ thật** trên stack thật; tự động (`test:chaos`) kiểm **chính xác tới câu lệnh** (S1, S2, S4, S11, S12) mà tay không làm được. Hai bên bổ sung nhau, không thay thế nhau.

## 6. Quyết định đã chốt

1. **CI:** không đưa `test:chaos` vào Jenkins (chốt).
2. **CHM-018:** được cấp quyền SQL; giữ case. Chỉ chạy trên local stack.
3. **Interval:** `deploy/compose.services.yml` nay nhận `PAYMENT_WORKER_INTERVAL_MS` và `WALLET_WORKER_INTERVAL_MS` (mặc định `500`, bằng giá trị mặc định cũ nên không đổi hành vi nếu không đặt). Đặt trong `deploy/.env`, ví dụ `PAYMENT_WORKER_INTERVAL_MS=20000`, rồi `docker compose -f deploy/compose.local.yml --env-file deploy/.env up -d payment` (tạo lại container) để có cửa sổ cho CHM-014/CHM-015. Đã kiểm `docker compose config` ra đúng `"20000"` và `"500"`; **chưa** khởi động stack. Nhớ bỏ biến sau khi test.
4. **Chạy trên stack thật:** người yêu cầu tự chạy các collection (kể cả Postman chaos) và `test:chaos`; kết quả sẽ được đối chiếu khi có.
