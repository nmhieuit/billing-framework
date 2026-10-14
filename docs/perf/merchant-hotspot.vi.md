# Điểm nóng MERCHANT: bộ đo, baseline và phân tích (Pha A)

Tài liệu cho người phát triển và người quyết định Pha B: bộ đo hiệu năng (`tests/perf`) đo trần thông lượng hiện tại của các thao tác
ghi sổ đi qua một dòng tài khoản hệ thống dùng chung (`system:MERCHANT:<cur>`, `system:GATEWAY:<cur>`), ghi lại baseline tái lập được
và đối chiếu ba giả thuyết H1–H3 với **số đo**. Thiết kế: [spec 6e](../superpowers/specs/2026-10-14-merchant-hotspot-design.md);
kế hoạch: [plan Pha A](../superpowers/plans/2026-10-14-merchant-hotspot-phase-a.md). Số liệu gốc (JSON sao nguyên từ bộ đo, không
chỉnh tay; `.md` cùng tên là bảng sinh tự động từ chính JSON đó), hai lượt chạy ma trận trên cùng máy, cùng commit:

- [`baseline-DESKTOP-MBR3422-2026-10-14.json`](baseline-DESKTOP-MBR3422-2026-10-14.json) (lượt 2, [`.md`](baseline-DESKTOP-MBR3422-2026-10-14.md)):
  baseline chính, vì `pay-order` (kịch bản điểm nóng MERCHANT) của lượt này chạy trong khoảng máy rảnh và sạch ở mọi mức.
- [`baseline-DESKTOP-MBR3422-2026-10-14-run1.json`](baseline-DESKTOP-MBR3422-2026-10-14-run1.json) (lượt 1,
  [`.md`](baseline-DESKTOP-MBR3422-2026-10-14-run1.md)): nguồn của `topup-apply` (mức 1 và 64), `mixed` và đầu-cuối, vì các phần này
  của lượt 1 rơi vào khoảng máy rảnh còn ở lượt 2 thì không (xem [Độ tin cậy của hai lượt](#độ-tin-cậy-của-hai-lượt-đo)).

> Bộ đo chạy trên **hạ tầng dựng riêng bằng testcontainers** (một SQL Server cho cả lượt chạy, mỗi môi trường đo một database riêng;
> phần đầu-cuối dùng thêm RabbitMQ của testcontainers). Nó **không dùng** stack `billing-local` và không bao giờ nên được trỏ vào môi
> trường dùng chung. Pha A **không đổi code production**: chỉ thêm `tests/perf/**`, script và tài liệu.

## Mục đích và phạm vi của Pha A

Mọi lần trả order ghi nợ ví khách và ghi có **một** dòng `system:MERCHANT:<cur>` của tenant; `PayOrder` khóa (`UPDLOCK, ROWLOCK`) hai
tài khoản theo id tăng dần, nên `system:MERCHANT:…` (đứng trước `wallet:…` theo thứ tự chữ cái) bị khóa **đầu tiên** và giữ tới commit.
Nạp tiền (`ApplyPaymentResult`) có hình dạng y hệt trên `system:GATEWAY:<cur>`, điều chỉnh trên `system:ADJUSTMENT:<cur>`.

Pha A chỉ **đo**: trần thông lượng theo mức đồng thời, độ trễ đuôi, chờ khóa, câu lệnh và tài nguyên bị chặn; rồi dừng để người dùng
chốt ngưỡng (mục cuối). Ngoài phạm vi: sửa code production, cổng CI, đo kiểu mở (tốc độ đến cố định), phần cứng giống production.

Bộ đo gồm:

- **Mức use case** (ba kịch bản, gọi thẳng use case thật của wallet trên SQL Server thật, đồng hồ và bộ sinh id thật):
  - `pay-order`: mỗi thao tác trả một order 1 000 VND cho một khách ngẫu nhiên trong 2 000 khách → điểm nóng MERCHANT.
  - `topup-apply`: mỗi thao tác áp `charge.succeeded` cho một topup `PENDING` chưa dùng (hàng đợi seed trước, ngoài cửa sổ đo) → điểm
    nóng GATEWAY.
  - `mixed`: 70% trả order, 15% áp nạp tiền, 10% điều chỉnh CREDIT ví (ADJUSTMENT), 5% đảo một `ORDER_PAYMENT` vừa tạo.
- **Đầu-cuối** (`e2e`): wallet + payment + broker thật trong tiến trình (`createSystem()` của harness chaos, không tiêm lỗi); Orders giả
  gửi 200 đơn bằng 16 luồng gửi kín, đo từ lúc gửi tới lúc nhận `OrderPaidV1`; sau đó `heal()` và oracle `assertSystemInvariants`.

Vòng tải là **vòng kín**: N luồng cố định, mỗi luồng gửi thao tác kế tiếp ngay khi thao tác trước xong. Thông lượng = số thao tác
**thành công** hoàn tất trong cửa sổ đo / độ dài cửa sổ; độ trễ chỉ tính thao tác thành công trong cửa sổ.

### Kiểm đúng đắn

- Mức use case: sau mỗi lượt, `tests/perf/support/validity.ts` kiểm sổ cái (mỗi giao dịch cân, số dư mỗi tài khoản bằng tổng dòng sổ
  cái, tổng số dư mọi tài khoản bằng 0) và đối chiếu hiệu số đếm sổ cái (`ORDER_PAYMENT`, `order_payments`, `TOPUP`, `REVERSAL`, `ADJUSTMENT`)
  với số thao tác thành công thực tế. Lệch → lượt đo **vô hiệu** (test ném lỗi). Đây là chỗ lệch so với spec ban đầu (spec định chạy
  `assertSystemInvariants` sau mỗi lượt): oracle đầy đủ cần cả payment, broker và đối soát nên chỉ dùng ở phần đầu-cuối.
- Đầu-cuối: oracle đầy đủ 8 bất biến của bộ chaos (xem [chaos-testing](../ops/chaos-testing.vi.md)).

## Cách chạy

Yêu cầu: Node 22, **Docker** (testcontainers kéo `mcr.microsoft.com/mssql/server:2022-latest` và `rabbitmq:3-management-alpine`), dùng
tiền tố `corepack pnpm` như phần còn lại của repo. Không dùng `--` khi lọc tệp.

```bash
corepack pnpm test:perf matrix        # ma trận đầy đủ: 3 kịch bản × 4 mức × 3 lần lặp + đầu-cuối, một báo cáo gộp (30–50 phút)
corepack pnpm test:perf pay-order     # một kịch bản (cũng: topup-apply, mixed, e2e), báo cáo một phần
corepack pnpm test:perf canary        # test "kênh quan sát": bộ đo phải thấy được tranh chấp khóa
```

`test:perf` (`vitest.perf.config.ts`) lấy mọi tệp `tests/perf/**/*.perf.test.ts`, chạy tuần tự từng tệp; **không** nằm trong `test`,
`test:integration` hay CI. Gọi `test:perf` không lọc sẽ chạy cả `matrix` lẫn từng kịch bản riêng (đo trùng lặp, gấp đôi thời gian):
nên luôn lọc. Báo cáo ghi vào `PERF_OUT`: `report-<nhãn máy>-<thời điểm>.json/.md` cho ma trận, `<kịch bản>-<nhãn máy>.json/.md` cho
từng tệp. Thư mục mặc định `tests/perf/.out/` bị git bỏ qua.

| Biến | Ý nghĩa | Mặc định |
| ---- | ------- | -------- |
| `PERF_CONCURRENCY` | Các mức đồng thời (số luồng vòng kín), cách nhau dấu phẩy | `1,4,16,64` |
| `PERF_DURATION_SECONDS` | Độ dài cửa sổ đo của mỗi lượt | `20` |
| `PERF_WARMUP_SECONDS` | Khởi động nóng trước cửa sổ đo (không tính) | `3` |
| `PERF_REPEATS` | Số lần lặp mỗi mức; báo cáo lấy trung vị và min–max | `3` |
| `PERF_CUSTOMERS` | Số khách (ví) seed, dùng chung cho mọi kịch bản | `2000` |
| `PERF_TENANTS` | Số tenant (Pha A: 1, tức một MERCHANT nóng) | `1` |
| `PERF_E2E_ORDERS` / `PERF_E2E_CONCURRENCY` | Số đơn và số luồng gửi của phần đầu-cuối | `200` / `16` |
| `PERF_MACHINE` | Nhãn máy ghi vào báo cáo; chỉ so sánh số đo cùng nhãn | tên host |
| `PERF_OUT` | Thư mục ghi báo cáo | `tests/perf/.out` |
| `PERF_SCENARIOS` | Chỉ chạy các tệp có tên trong danh sách (`pay-order`, `topup-apply`, `mixed`, `e2e`, `matrix`) | tất cả |

**Thời lượng và chi phí seed.** Mỗi lượt tốn 3 + 20 giây tải cộng xả, `CHECKPOINT` và `UPDATE STATISTICS` trước lượt (36 lượt use
case). Seed 2 000 khách (qua `CreateWallet` + `AdjustWallet` thật) mất ~50 giây, một lần cho cả ma trận. Trên máy này ma trận mặc định
mất 32 phút khi máy gần như rảnh và 52 phút khi bị tải nền (seed chậm đi tới 10 lần). `topup-apply` và `mixed` seed trước một hàng đợi topup
`PENDING` cho **mỗi** lượt (~8 ms mỗi topup, ngoài cửa sổ đo); cỡ hàng đợi là cận tĩnh `estimateMaxOps` từ hai trần
`PER_WORKER_OPS_PER_SEC` / `TOTAL_OPS_PER_SEC` trong `tests/perf/support/runner.ts` (hiệu chuẩn trên máy này, khoảng 2 lần thông lượng cao
nhất đo được). Hàng đợi cạn giữa lượt là **lỗi rõ ràng** (không quay vòng): khi đó nâng hai trần rồi chạy lại.

**Máy phải rảnh.** `sys.dm_os_wait_stats` là thống kê của cả instance và CPU của máy dev dùng chung cho cả bộ sinh tải lẫn SQL Server:
đóng ứng dụng nặng, không chạy test hay build khác trong lúc đo. Stack `billing-local` (nếu đang chạy) dùng SQL Server riêng nên không
làm bẩn bảng chờ, nhưng vẫn ăn CPU của máy: ghi lại trong báo cáo. Bộ đo **không** tự cảnh báo tải nền (spec có nêu, chưa làm); kiểm
bằng `docker stats` và Task Manager trước khi chạy.

## Cách đọc báo cáo

- **Thông lượng/giây (trung vị, min–max):** trung vị của 3 lần lặp và khoảng min–max. Khoảng rộng hơn ~25% trung vị ở nhiều mức là dấu
  hiệu máy bị nhiễu: chạy lại.
- **p95 / p99 (ms):** trung vị qua các lần lặp của phân vị độ trễ (tính chính xác từ mẫu thô) của thao tác thành công trong cửa sổ.
  Trong vòng kín, độ trễ ≈ số luồng / thông lượng (định luật Little): khi thông lượng đã bão hòa, tăng luồng chỉ làm độ trễ tăng tuyến tính.
- **Lỗi:** tổng lỗi qua các lần lặp, tách `deadlock` (1205), `timeout` (1222/ETIMEOUT) và `other` trong JSON (`errors`).
- **Chờ khóa `LCK_M_*`** (`waits` của từng lần lặp trong JSON): hiệu `sys.dm_os_wait_stats` trước/sau phần tải, gồm tổng ms chờ và số
  lần chờ. `LCK_M_U` = chờ khóa cập nhật (`UPDLOCK`), `LCK_M_X` = chờ khóa độc quyền, `LCK_M_S` = chờ khóa đọc (vd kiểm khóa ngoại).
- **Câu lệnh bị chặn** (mục "Chờ khóa nổi bật"): mỗi 100 ms, bộ lấy mẫu chụp các request có `blocking_session_id <> 0` trong database đo,
  gom theo (loại chờ, câu lệnh chuẩn hóa 120 ký tự), kèm `wait_resource` gặp nhiều nhất. Số lần là **số mẫu** (một request chờ lâu bị đếm
  nhiều lần), không phải số thao tác. `KEY: <db>:<hobt> (<hash>)` là một dòng của chỉ mục; phần ghi chú của báo cáo ma trận ánh xạ
  hash → tài khoản hệ thống (vd `(b8079320b67d)` = `system:MERCHANT:VND`).
- **Chờ ngoài khóa** (ghi chú của báo cáo ma trận, mỗi lượt một dòng): `WRITELOG` (chờ ghi log khi commit), `ASYNC_NETWORK_IO`,
  `PAGELATCH_*`, `PAGEIOLATCH_*`, `SOS_SCHEDULER_YIELD`, đo quanh phần tải (khởi động + đo + xả + kiểm sổ cái), kèm trung bình ms mỗi lần
  chờ và số lần chờ mỗi thao tác. Dùng để so trần thông lượng với sàn commit.

## Baseline 2026-10-14 (máy `DESKTOP-MBR3422`)

Máy: 4 CPU logic, 31,9 GB RAM, Windows 11 (10.0.22000) + Docker Desktop, Node v22.20.0, SQL Server 2022 RTM-CU26 (16.0.4265.3) trong
container testcontainers; commit `ac66438`. Cấu hình mặc định: mức 1, 4, 16, 64; cửa sổ 20 s; khởi động 3 s; 3 lần lặp; 2 000 khách;
1 tenant; đầu-cuối 200 đơn với 16 luồng. Mọi lượt của cả hai lần chạy đều **hợp lệ** (sổ cái cân, đếm khớp, bất biến đầu-cuối đạt).

### Độ tin cậy của hai lượt đo

Máy dev không rảnh hoàn toàn: stack `billing-local` (7 container) chạy suốt buổi đo (~15–20% một lõi khi nghỉ, không đụng SQL Server của
bộ đo), cùng Docker Desktop, Postman, VS Code, Zalo, Chrome. Một vòng ghi nhật ký mỗi phút (tiến trình ngốn CPU nhiều nhất trong 10 s)
cho thấy các đợt tải nền trùng khớp với các lượt đo bất thường:

| Lượt | Khoảng thời gian | Tải nền ghi nhận | Phần đo bị ảnh hưởng |
| ---- | ---------------- | ---------------- | -------------------- |
| 1 (08:41–09:13, 32 phút) | 08:45–08:47 | `BackgroundDownload` ~2,5 lõi | `pay-order` mức 16 và mức 64 lần 1–2 (17–22/s thay vì ~50/s) |
| 1 | 08:53–09:04 | tiến trình giao diện Docker Desktop ~1 lõi | `topup-apply` mức 4 lần 3, mức 16, mức 64 lần 1 (seed mất 84–271 s thay vì 25–33 s) |
| 1 | 09:05–09:13 | rảnh | `topup-apply` mức 64 lần 2–3, `mixed`, đầu-cuối |
| 2 (09:14–10:06, 52 phút) | 09:15–09:22 | rảnh | `pay-order` (mọi mức) |
| 2 | 09:23–10:06 | Docker Desktop ~1 lõi, rồi Postman ~1,5 lõi | `topup-apply`, `mixed`, đầu-cuối (có 8 + 1 timeout, `mixed` mức 1 chỉ 6,8/s) |

Dấu hiệu từ phía SQL Server khớp với nhật ký: ở các lượt bị nhiễu, `WRITELOG` trung bình tăng từ ~0,7 ms lên 4–39 ms mỗi lần và
`SOS_SCHEDULER_YIELD` tăng mạnh (CPU của VM Docker bị chia). Theo luật của kế hoạch, ma trận được **chạy lại đúng một lần**; cả hai báo
cáo được giữ nguyên. Bảng dưới lấy mỗi kịch bản từ lượt mà khoảng thời gian của nó rảnh; mức còn nhiễu được đánh dấu ⚠ và **không**
dùng để kết luận.

### Bảng baseline

Thông lượng = trung vị 3 lần lặp (thao tác thành công/giây), kèm min–max; p95/p99 = trung vị các lần lặp (ms). Không lượt nào có
deadlock; lỗi chỉ xuất hiện ở các lượt nhiễu của lượt 2 (timeout).

**`pay-order`** (điểm nóng MERCHANT; lượt 2, sạch):

| Mức | Thông lượng/s (min–max) | p95 | p99 | Lỗi |
| --- | ----------------------- | --- | --- | --- |
| 1 | 37,6 (36,7–37,7) | 39,9 | 54,5 | 0 |
| 4 | 50,5 (50,1–53,5) | 129,1 | 180,1 | 0 |
| 16 | 52,8 (51,6–52,8) | 442,4 | 499,3 | 0 |
| 64 | 49,8 (47,5–53,0) | 1 893,7 | 2 086,5 | 0 |

**`topup-apply`** (điểm nóng GATEWAY; lượt 1):

| Mức | Thông lượng/s (min–max) | p95 | p99 | Lỗi |
| --- | ----------------------- | --- | --- | --- |
| 1 | 30,8 (29,2–33,3) ⚠ thấp hơn hiệu chuẩn 28% | 56,4 | 98,7 | 0 |
| 4 | 40,9 (23,9–41,2) ⚠ lần 3 | 146,9 | 209,1 | 0 |
| 16 | 19,3 (8,2–25,8) ⚠ | 3 025,6 | 3 918,3 | 0 |
| 64 | 54,5 (42,8–57,1) ⚠ lần 1 | 1 620,6 | 1 676,1 | 0 |

Lượt 2 của `topup-apply` nhiễu nặng hơn ở mức 1, 16, 64 (mức 16: 8,8/s, 8 timeout; mức 64: 18,5/s), nhưng **mức 4 của lượt 2 sạch hơn
lượt 1**: 44,1 (39,2–45,6, độ phân tán 14%). Lượt hiệu chuẩn 8 s trước đó (máy rảnh, 1 lần lặp) đo 43,0 / 58,5 / 51,4 thao tác/s ở
1 / 16 / 64 luồng; mức 1 của baseline (30,8) thấp hơn số đó 28% dù khoảng thời gian đó không ghi nhận tải nền, nên coi là chưa chắc
chắn. Trần GATEWAY cùng cỡ với trần MERCHANT.

**`mixed`** (70% trả order / 15% nạp / 10% điều chỉnh / 5% đảo; lượt 1, khoảng rảnh):

| Mức | Thông lượng/s (min–max) | p95 | p99 | Lỗi |
| --- | ----------------------- | --- | --- | --- |
| 1 | 37,1 (36,5–38,7) | 45,0 | 65,8 | 0 |
| 4 | 48,1 (47,7–60,9) ⚠ phân tán 27% | 132,9 | 177,9 | 0 |
| 16 | 49,4 (47,5–49,4) | 618,4 | 767,7 | 0 |
| 64 | 40,4 (38,5–46,3) | 3 461,5 | 4 818,4 | 0 |

**Đầu-cuối** (200 đơn, 16 luồng gửi; lượt 1, khoảng rảnh): **14,0 đơn/s**, p50 / p95 / p99 = 1 095 / 1 431 / 1 487 ms, bất biến đạt.
(Lượt 2, bị Postman tải nền: 8,2 đơn/s, p99 4 318 ms.)

**Để so sánh, `pay-order` của lượt 1 (nhiễu):** 31,3 / 42,7 / 19,9 ⚠ / 17,2 ⚠ thao tác/s ở 1 / 4 / 16 / 64 luồng.

### Chờ khóa và câu lệnh bị chặn

`pay-order` (lượt 2): `LCK_M_*` trong mỗi lượt chỉ gồm `LCK_M_U` (và vài `LCK_M_S` vài ms):

| Mức | Tổng chờ `LCK_M_U` mỗi lượt (s) | Số lần chờ / số thao tác đã bắt đầu | Chờ TB mỗi lần (ms) | Số luồng đang chờ khóa TB (tổng chờ chia cho khoảng 23,1–24,5 s từ lúc chụp trước khởi động nóng tới sau khi xả) |
| --- | ------------------------------- | ----------------------------------- | ------------------- | ---------------------------------------------------- |
| 1 | 0 | 0 | – | 0 |
| 4 | 56,5–57,0 | 1 151 / 1 152 (lần 1) | ~49 | ~2,4 / 4 |
| 16 | 333,3–335,3 | 1 217 / 1 218 (lần 1) | ~274 | ~14,3 / 16 |
| 64 | 1 454,8–1 462,3 | 1 254 / 1 255 (lần 1) | ~1 160–1 250 | ~60 / 64 |

Câu lệnh bị chặn (mẫu 100 ms, gộp mọi mức và lần lặp):

| Kịch bản | Loại chờ | Câu lệnh | Số mẫu | Tài nguyên |
| -------- | -------- | -------- | ------ | ---------- |
| `pay-order` (lượt 2) | `LCK_M_U` | `select … from accounts with (updlock, rowlock) where id = @1` (`lockMany`) | 50 938 | 100% `KEY (b8079320b67d)` = `system:MERCHANT:VND` |
| `pay-order` (lượt 2) | `LCK_M_S` | `select * from accounts where id = @1` (đọc ví) | 2 | hai ví khác nhau |
| `topup-apply` (lượt 1) | `LCK_M_U` | `lockMany` như trên | 47 586 | 100% `KEY (49950b0e6a67)` = `system:GATEWAY:VND` |
| `mixed` (lượt 1) | `LCK_M_U` | `lockMany` | 46 279 | MERCHANT 46 058, GATEWAY 175, `system:ADJUSTMENT:VND` 46 |
| `mixed` (lượt 1) | `LCK_M_S` | `select e.account_id, e.amount, a.currency from ledger_entries e join accounts a …` (`findTransaction` của đảo giao dịch) | 2 786 | 100% MERCHANT |

Không có một mẫu nào của `insert into ledger_entries` (hay câu lệnh ghi nào khác) chờ khóa trên dòng `accounts`, ở cả ba kịch bản và
hai lượt; chờ trên dòng ví **gần như không** có (2 mẫu `LCK_M_S` ở `pay-order` lượt 2, 1 mẫu ở `mixed` lượt 1). Trong `mixed`, `LCK_M_S` mỗi lượt là 1,6–1,7 s (mức 4), 15–26 s (mức 16), 78–96 s
(mức 64), trung bình 1,6–2,2 s mỗi lần chờ ở mức 64.

**Chờ ngoài khóa** (`pay-order`, lượt 2): `WRITELOG` đúng ~1,00 lần mỗi thao tác (một commit), trung bình **0,66–0,80 ms** mỗi lần ở mọi
mức; không ghi nhận `ASYNC_NETWORK_IO`, `LOGBUFFER`; `PAGELATCH_*`/`PAGEIOLATCH_*` chỉ vài lần mỗi lượt.

## Phân tích (chỉ từ số đo trên)

### 1. Đường cong thông lượng theo mức đồng thời

- `pay-order` **bão hòa ở mức 4**: 37,6 → 50,5 (+34%) → 52,8 (+5%) → 49,8 (−6%, khoảng min–max của mức 16 và 64 chồng nhau). Trần
  ~50–53 thao tác/s, tức chỉ 1,4 lần thông lượng một luồng. Không sụp đổ ở 64 luồng: không deadlock, không timeout.
- `topup-apply`: trần cùng cỡ (54,5–57,1 ở mức 64 trong các lần lặp sạch; hiệu chuẩn 58,5 ở mức 16); mức 16 của baseline nhiễu nên
  không đọc được điểm bão hòa chính xác, nhưng mức 4 (41) đã gần trần.
- `mixed`: 37,1 → 48,1 → 49,4 → 40,4. Bão hòa ở mức 4–16 và **giảm ~18% ở mức 64** (khoảng 38,5–46,3 không chồng 47,5–49,4).

**Thời gian giữ khóa là SUY RA, không đo.** Một luồng mất 1 / 37,6 ≈ 26,6 ms mỗi thao tác. Nếu hệ thống tuần tự hoàn toàn trên một
dòng (bằng chứng độc lập ở mục 3), thời gian giữ khóa MERCHANT trung bình mỗi transaction ≈ 1 / thông lượng: 19,8 / 18,9 / 20,1 ms ở
mức 4 / 16 / 64. Đây chỉ là nghịch đảo của thông lượng dưới giả định đó, **không** phải bằng chứng thêm cho giả định; bộ đo không đo
thời gian từng câu lệnh nên thành phần của ~19 ms chưa biết. Theo code `PayOrder` (đọc code, không đo): trước khi khóa MERCHANT có
khoảng 3–4 lượt đi-về (inbox, tìm order đã trả, đọc ví), sau khi khóa có khoảng 8–9 (khóa ví, 2 `UPDATE` số dư, 2 `INSERT` sổ cái,
`order_payments`, outbox, commit).

**Thời gian giữ có bị thổi phồng bởi máy (CPU, Node, Docker, chính bộ sinh tải) không?** Bằng chứng từ baseline, theo hai chiều:

- Chiều "không bị thổi phồng nhiều" (lượt 2, khi máy rảnh): `SOS_SCHEDULER_YIELD` của SQL Server nhỏ (2–55 ms mỗi lượt ~23 s ở mức 1–16,
  95–249 ms ở mức 64, tức < 1% thời gian); chia ~19 ms cho ~9 lượt đi-về là ~2,1 ms mỗi lượt, ngang 26,6 ms / ~12 lượt ≈ 2,2 ms mỗi lượt
  khi một luồng không tranh chấp; thời gian giữ suy ra phẳng từ mức 4 đến 64 (19,8 / 18,9 / 20,1 ms) dù số luồng của bộ sinh tải tăng 16
  lần.
- Chiều ngược lại (lượt 1, có tải nền ~2,5 lõi): tổng chờ `LCK_M_U` ở mức 16 vẫn 332–335 s mỗi lượt (y như lượt 2, vì trong vòng kín
  hầu hết luồng luôn chờ) trong khi thông lượng rơi xuống 17–22/s, tức thời gian giữ suy ra ≈ 45–57 ms, **gấp ~2,5–3 lần**. Đoạn giữ khóa
  rất nhạy với môi trường: mọi trễ thêm của CPU host, Docker Desktop hay Node khi đang giữ khóa đều kéo dài nó.
- CPU của Node và của SQL Server **không** được đo trong hai lượt baseline. Phép đo bổ sung
  ([Đo bổ sung](#đo-bổ-sung-mở-rộng-theo-số-tenant)) đo trực tiếp: với 1 tenant, Node dùng 38–45% một lõi và trễ vòng lặp p50 ≤ 0,5 ms
  (bộ sinh tải không bão hòa), còn container SQL dùng ~51–59% một lõi, tức ~10–13 ms CPU mỗi thao tác (cận trên). Thêm tenant (thêm dòng
  MERCHANT) chỉ tăng thông lượng tổng 1,2–1,7 lần: có một giới hạn dùng chung của máy ngay phía trên giới hạn của dòng.

### 2. Độ trễ đuôi

`pay-order` p99: 54,5 → 180 → 499 → 2 087 ms (×38 từ 1 lên 64 luồng) trong khi thông lượng chỉ ×1,32. Trung vị p50 khớp luật Little
cho một hàng đợi đơn: 16 / 52,8 = 303 ms so với p50 277–284 ms; 64 / 49,8 = 1 285 ms so với p50 1 153–1 233 ms. Tức là trên trần, mỗi
luồng thêm vào chỉ cộng thêm ~19 ms vào độ trễ của mọi thao tác. p99 chỉ cao hơn p50 ~1,7–1,8 lần ở mức 16–64 (hàng đợi gần FIFO, không
có thao tác bị bỏ đói lâu). `mixed` mức 64 có đuôi xấu hơn (p99 4 818 ms ≈ 2,8 lần p50 ~1,7 s), trùng với các lần chờ `LCK_M_S` 1,6–2,2 s của
lệnh đảo.

Độ nhạy với nhiễu: ở lượt 1, khi một tiến trình nền ăn ~2,5 lõi, `pay-order` mức 16 rơi từ ~52 xuống 17–22/s (−60%) và p99 tăng ~4 lần;
ở lượt 2, `topup-apply` mức 16 rơi xuống 1,4/s kèm 8 timeout. Mọi độ trễ cộng thêm **bên trong** đoạn giữ khóa (CPU bị chia, ghi log
chậm) được nhân lên cho cả hàng đợi.

### 3. Chờ khóa nổi bật, câu lệnh và tài nguyên bị chặn

- **Câu lệnh chờ là `lockMany` lấy `UPDLOCK` trên chính dòng tài khoản hệ thống**: 100% mẫu `LCK_M_U` của `pay-order` nằm trên đúng một
  khóa `KEY (b8079320b67d)` = `system:MERCHANT:VND`; của `topup-apply` trên `KEY (49950b0e6a67)` = `system:GATEWAY:VND`. Mọi người chờ
  xếp hàng trên **cùng một khóa**.
- Hàng đợi gần như đầy: tổng chờ `LCK_M_U` chia cho khoảng 23–24,5 s (từ trước khởi động nóng tới sau khi xả) cho thấy ≈2,4/4,
  ≈14,3/16 và ≈60/64 luồng luôn đang chờ (khoảng N − 2 luồng), và mỗi thao tác chờ đúng một lần (số lần chờ ≈ số thao tác). Chờ trung
  bình mỗi lần ≈ (số luồng − 1) × thời gian phục vụ ~19 ms: đúng hình dạng của một hàng đợi một chỗ phục vụ.
- **Không** có mẫu nào của `insert into ledger_entries` (kiểm khóa ngoại `account_id → accounts`) hay `update accounts` bị chặn; chờ trên
  dòng ví gần như không có (2 mẫu; khách chọn ngẫu nhiên trong 2 000 nên hầu như không trùng).
- Trong `mixed`, ngoài `lockMany`, có một câu lệnh **đọc** xếp hàng trên dòng MERCHANT: `findTransaction` của `ReverseTransaction` đọc
  `ledger_entries` JOIN `accounts` (database dùng read committed có khóa nên lệnh đọc lấy `S` trên dòng MERCHANT) **trước** khi gọi
  `lockMany`; 2 786 mẫu, tất cả trên MERCHANT, chờ TB 1,6–2,2 s ở mức 64.
- `WRITELOG` ~0,7 ms mỗi commit, một lần mỗi thao tác: ở trần 52,8/s, ghi log chiếm 52,8 × 0,7 ≈ 37 ms mỗi giây (~4%) của đoạn giữ khóa
  nối tiếp. Phần còn lại của ~19 ms không hiện thành chờ phía server nào trong bảng: đó là thời gian session giữ khóa trong lúc không
  chạy câu lệnh nào (đi-về giữa Node và SQL Server qua Docker Desktop, xử lý ở Node). Đây là suy luận từ việc thiếu loại chờ khác, không
  phải số đo trực tiếp từng câu lệnh.

### 4. Nhận định giả thuyết

| | Giả thuyết | Kết luận | Bằng chứng |
| - | ---------- | -------- | ---------- |
| H1 | Thông lượng trả order bị chặn trên bởi thời gian giữ khóa dòng MERCHANT; thứ tự khóa (MERCHANT trước) kéo dài thời gian giữ | **ĐÚNG phần "hệ thống tuần tự hóa trên dòng MERCHANT"** (1 tenant); thành phần của thời gian giữ ~19 ms (suy ra, không đo) và phần do thứ tự khóa: **chưa đo** | Bằng chứng độc lập: 100% mẫu `LCK_M_U` trên một khóa `KEY (b8079320b67d)` = MERCHANT; khoảng N − 2 luồng luôn đang chờ; chờ mỗi thao tác ≈ (N − 1) × thời gian phục vụ; thông lượng phẳng từ mức 4 tới 64. Thời gian giữ ~19 ms chỉ là 1 / thông lượng, không phải bằng chứng riêng. Vì MERCHANT bị khóa trước, đoạn giữ gồm cả lượt khóa ví và mọi câu lệnh sau đó (~8–9 lượt đi-về theo code), nhưng bộ đo không đo thời gian từng câu lệnh. Đo bổ sung theo số tenant: dòng MERCHANT là giới hạn đang chặn ở 1 tenant (thêm dòng thì thông lượng tổng tăng 19–67%), nhưng **không** phải giới hạn duy nhất: máy có một giới hạn dùng chung chỉ cao hơn ~1,2–1,7 lần ([Đo bổ sung](#đo-bổ-sung-mở-rộng-theo-số-tenant)) |
| H2 | Kiểm khóa ngoại `ledger_entries → accounts` xếp hàng trên dòng MERCHANT dù khóa muộn | **CHƯA KẾT LUẬN** | 0 mẫu `insert into ledger_entries` bị chặn trong mọi kịch bản: với thứ tự hiện tại, transaction đã giữ khóa MERCHANT trước khi chèn nên kiểm khóa ngoại không phải chờ ai; giả thuyết nói về thiết kế sau khi đổi thứ tự, không quan sát được nếu không đổi code. Chỉ dấu liên quan: lệnh **đọc** dòng MERCHANT (`findTransaction`, `LCK_M_S`, 2 786 mẫu, 1,6–2,2 s mỗi lần ở mức 64) có xếp hàng sau người giữ khóa, nên một lệnh cần khóa `S` trên dòng MERCHANT (như kiểm khóa ngoại) nhiều khả năng cũng sẽ xếp hàng; Pha B phải đo lại sau khi đổi thứ tự |
| H3 | Ở nhiều luồng, `LCK_M_*` và p99 tăng nhanh hơn thông lượng | **ĐÚNG** | 4 → 64 luồng: thông lượng −1% (50,5 → 49,8), tổng chờ `LCK_M_U` ×26 (57 s → 1 460 s mỗi lượt), p99 ×11,6 (180 → 2 087 ms); 1 → 64 luồng: thông lượng ×1,32, p99 ×38. Lưu ý: mức tăng ×26 của tổng chờ là hệ quả cơ học của vòng kín (tổng chờ ≈ số luồng đang chờ × độ dài khoảng đo), **không** phải phát hiện độc lập; bằng chứng thực chất là thông lượng phẳng trong khi p99 tăng tuyến tính theo số luồng. Dạng tăng là của một hàng đợi đơn (luật Little), không phải sụp đổ: không deadlock, không timeout khi máy rảnh |

### 5. So sánh các kịch bản

- **`pay-order` và `topup-apply`** có cùng hình dạng và cùng cỡ trần (~50–58/s), mỗi bên một dòng nóng (MERCHANT, GATEWAY). Nút cổ chai
  không riêng gì MERCHANT: mọi luồng ghi đi qua một dòng tài khoản hệ thống của (tenant, đồng tiền) đều có trần này.
- **Lưu ý khi so giữa hai lượt:** ngay cả ở các mức không ghi nhận tải nền, hai lượt lệch nhau ~15%: `pay-order` lượt 1 ở mức 1 và 4
  (31,3 và 42,7/s) thấp hơn lượt 2 (37,6 và 50,5/s) 15–17%, `WRITELOG` TB của lượt 1 là 0,83–1,25 ms so với 0,66–0,74 ms của lượt 2. Vì
  vậy chỉ so các kịch bản **trong cùng một lượt** khi có thể; chênh lệch dưới ~15% giữa hai lượt không có ý nghĩa.
- **`mixed` so với `pay-order` trong cùng lượt 1:** ở mức 4, `mixed` 48,1/s (⚠ phân tán 27%) **cao hơn** `pay-order` 42,7/s; ở mức 16,
  `mixed` 49,4/s còn `pay-order` lượt 1 bị nhiễu nên không so được. Phần đi qua MERCHANT của `mixed` (trả order + đảo, ~75%) ở mức 16 là
  ~37/s; 99,5% mẫu `LCK_M_U` vẫn nằm trên MERCHANT. Số đo **không** cho phép kết luận dòng MERCHANT bị giữ lâu hơn trong `mixed`: thông
  lượng tổng không thấp hơn `pay-order` cùng lượt, còn so với trần 52,8/s của lượt 2 thì vướng chênh lệch giữa hai lượt. Hai điểm riêng
  của `mixed` có trong số đo: lệnh đảo đọc dòng MERCHANT bằng khóa `S` trước khi khóa (mục 3), và `WRITELOG` TB 1,6–2,8 ms, 1,06–1,26 lần
  mỗi thao tác (so với 0,83–1,25 ms, 1,00–1,01 lần của `pay-order` cùng lượt ở mức 1–4). `mixed` là kịch bản duy nhất giảm rõ ở 64 luồng
  (−18%, khoảng min–max không chồng mức 16).
- **Đầu-cuối** chỉ đạt 14,0 đơn/s ở 16 luồng, ~3,8 lần dưới trần `pay-order` (52,8/s) cùng mức; p50 1 095 ms đúng bằng 16 / 14,0 s. Với
  harness này (broker, relay outbox theo lô, Orders giả trong cùng tiến trình), MERCHANT **không phải** nút cổ chai của đường đầu-cuối ở
  200 đơn × 16 luồng. Bộ đo không chụp chờ khóa cho phần đầu-cuối nên không nói được nút cổ chai ở đâu.

### 6. Trần commit/ghi log hay khóa MERCHANT?

Căn cứ: `WRITELOG` mỗi commit của `pay-order` chỉ 0,66–0,80 ms, một lần mỗi thao tác, tức ~4% của thời gian giữ ~19 ms (suy ra); và
thông lượng phẳng từ mức 4 tới 64 trong khi mọi luồng thừa nằm trong hàng đợi `LCK_M_U` của **một** khóa. Nếu ghi log là giới hạn,
`WRITELOG` mỗi lần phải tăng theo tải và chiếm phần lớn thời gian phục vụ; cả hai đều không xảy ra. Kết luận: trần hiện tại **không** phải
sàn commit/ghi log. Chỉ để tham khảo về dung lượng ghi log của máy: canary (Task 3, ghi trong nhật ký tiến độ, không có tệp kết quả
được commit, và là tải khác hẳn: `UPDATE` một dòng tự commit) chạy được ~390–425 commit/giây với 8 luồng trên 8 dòng khác nhau, tức
ghi log của máy chịu được nhiều commit hơn mức `pay-order` đang dùng.

### 7. Giới hạn

- Máy dev Windows + Docker Desktop (VM WSL2), 4 CPU dùng chung cho bộ sinh tải Node, SQL Server và mọi ứng dụng khác; đi-về Node ↔ SQL
  Server đi qua lớp mạng của Docker Desktop. Số tuyệt đối **không** đại diện cho production; chỉ so sánh số đo cùng nhãn máy.
- Hai lượt đều có tải nền ở một phần thời gian (bảng trên); baseline ghép mỗi kịch bản từ lượt sạch hơn, `topup-apply` mức 4 và 16 vẫn
  còn nhiễu. Nên đo lại khi máy rảnh hẳn (đóng Postman, cửa sổ Docker Desktop, dừng tải nền) trước khi dùng `topup-apply` làm mốc.
- Vòng kín, không phải tốc độ đến cố định: độ trễ ở mức cao chủ yếu là thời gian xếp hàng do chính bộ đo tạo ra; không nói được độ trễ
  ở một tốc độ đến cụ thể (đó là việc của đo kiểu mở ở Pha B nếu cần).
- Baseline là một tenant, một đồng tiền (VND): trần đo được là **trần của một dòng MERCHANT**. Nhiều tenant chỉ được đo bổ sung cho
  `pay-order` ở mức 16 và 64 (mục riêng), và mức 64 với 4 tenant không ổn định.
- Bộ đo use case gọi thẳng use case, không qua broker/HTTP; đầu-cuối chỉ một cấu hình (200 đơn, 16 luồng) và không có bảng chờ khóa.
- Không đo thời gian từng câu lệnh trong đoạn giữ khóa; các con số lượt đi-về lấy từ đọc code.

## Đo bổ sung: mở rộng theo số tenant

**Câu hỏi:** trần ~50/s là của **dòng** MERCHANT, hay của bộ sinh tải / CPU / mạng của máy? Mỗi tenant có dòng `system:MERCHANT:VND`
riêng (schema riêng, cùng database), nên nếu trần là theo dòng thì thông lượng tổng phải tăng gần tuyến tính theo số tenant.

**Cách đo:** chỉ `pay-order`, mức 16 và 64, 2 lần lặp, 2 000 khách chia đều cho các tenant, `PERF_TENANTS` = 1 (đối chứng, cùng buổi),
rồi 2, rồi 4 (`PERF_SCENARIOS=pay-order PERF_CONCURRENCY=16,64 PERF_REPEATS=2`). Mỗi lượt ghi thêm (trường `resources`): CPU của tiến
trình Node (`process.cpuUsage`, phần trăm của một lõi), trễ vòng lặp sự kiện (`monitorEventLoopDelay`, đã trừ chu kỳ 10 ms) và CPU
container SQL Server testcontainers (`docker stats`, phần trăm của một lõi, ~4 mẫu mỗi lượt; gồm cả bộ lấy mẫu chờ khóa và tác vụ nền).
Máy kiểm trước khi đo: chỉ stack `billing-local` khi nghỉ và giao diện Docker Desktop (~0,1–0,7 lõi, có một đợt ~1,3 lõi lúc 10:30 trong lượt
`t2`). Vì `t4` mức 64 bất thường, `t4` được **chạy lại một lần** (11:04–11:08, kiểm tải trước khi chạy: rảnh; không ghi nhật ký tải
trong lúc chạy lại). Số liệu gốc: [`t1`](tenants-scaling-DESKTOP-MBR3422-2026-10-14-t1.json),
[`t2`](tenants-scaling-DESKTOP-MBR3422-2026-10-14-t2.json), [`t4`](tenants-scaling-DESKTOP-MBR3422-2026-10-14-t4.json),
[`t4` chạy lại](tenants-scaling-DESKTOP-MBR3422-2026-10-14-t4-rerun.json). Mọi lượt hợp lệ (sổ cái, đếm khớp).

| Tenant | Mức | Thông lượng tổng/s, trung vị (min–max) | Mỗi dòng MERCHANT/s | p99 (ms) | CPU Node (% một lõi) | Trễ vòng lặp p50 / p99 (ms) | CPU SQL TB (% một lõi) |
| ------ | --- | -------------------------------------- | ------------------- | -------- | -------------------- | --------------------------- | ---------------------- |
| 1 | 16 | 50,2 (49,0–51,4) | 50 | 845 | 44–45 | 0,4–0,5 / 7,5–7,6 | 58–59 |
| 1 | 64 | 51,2 (50,4–52,0) | 51 | 1 814 | 38 | 0,4–0,5 / 6,8–8,1 | 51–53 |
| 2 | 16 | 59,9 (59,0–60,8) | ~30 | 752 | 48–51 | 0,3 / 6,9–7,6 | 66–77 |
| 2 | 64 | 69,4 (65,1–73,8) | ~35 | 2 101 | 52–56 | 0,3 / 6,8–7,6 | 76–77 |
| 4 | 16 | 71,0 (68,5–73,6) | ~18 | 783 | 57 | 0,3 / 7,4–8,6 | 85–98 |
| 4 (chạy lại) | 16 | 83,9 (74,3–93,6) | ~21 | 565 | 51–63 | 0,2–0,3 / 5,5–9,9 | 76–84 |
| 4 | 64 | 34,6 (19,0–50,3) ⚠ | – | 5 394 | 33–51 | 0,5–1,7 / 9,5–13,2 | 67–82 |
| 4 (chạy lại) | 64 | 7,7 (2,3–13,2) ⚠ 38 timeout | – | 14 513 | 12–39 | 3,4–5,7 / 14,4–30,3 | 50–57 |

Đối chứng `t1` khớp baseline (50,2 / 51,2 so với 52,8 / 49,8 ở lượt 2). Với 2 và 4 tenant, mẫu chờ khóa chia thành 2 và 4 nhóm, mỗi nhóm
trên dòng `system:MERCHANT:VND` của một schema (cùng hash `b8079320b67d`, khác `hobt`): mỗi dòng có hàng đợi riêng như dự kiến.

**Kết luận:**

- **Thông lượng tổng KHÔNG tăng tuyến tính theo số dòng.** Ở mức 16: ×1,19 với 2 tenant và ×1,41–1,67 với 4 tenant (lý tưởng ×2 và ×4).
  Mỗi dòng MERCHANT chỉ còn ~30/s (2 tenant) và ~18–21/s (4 tenant), dù với 4 tenant mỗi dòng chỉ có ~4 luồng, mức mà một dòng đơn lẻ đạt
  ~50/s (baseline mức 4). Tức là thời gian giữ khóa mỗi dòng **dài ra** khi nhiều dòng cùng hoạt động: có một giới hạn **dùng chung** thứ
  hai, trên máy này nằm quanh **~60–90 thao tác/s tổng** ở 16 luồng.
- Với 1 tenant, dòng MERCHANT **là** giới hạn đang chặn (thêm dòng thì thông lượng tổng tăng 19–67%), nhưng giới hạn dùng chung chỉ cao hơn
  nó ~1,2–1,7 lần trên máy này.
- **Bộ sinh tải (vòng lặp sự kiện Node) không phải giới hạn:** ở các lượt bình thường, CPU Node 38–63% của một lõi và trễ vòng lặp p50
  ≤ 0,5 ms, p99 ≤ 10 ms, gần như không đổi từ 50 lên ~90 thao tác/s.
- **CPU của SQL Server tăng theo thông lượng:** ~51–59% một lõi (1 tenant) → 66–77% (2) → 76–98% (4), tức ~10–13 ms CPU của container SQL
  cho mỗi thao tác (con số này gồm cả bộ lấy mẫu chờ khóa 10 lần/giây và tác vụ nền nên là cận trên). Cỡ đó so được với thời gian giữ suy
  ra ~19 ms, nên rất có thể một phần đáng kể của đoạn giữ khóa là CPU thực thi câu lệnh trong VM Docker chứ không chỉ đi-về mạng; nhưng
  CPU trung bình của SQL vẫn dưới ~1 lõi trên 4 lõi của máy và CPU toàn máy (VM WSL2, lớp mạng Docker) **không** đo được, nên giới hạn dùng
  chung **chưa xác định** là CPU SQL, CPU máy hay lớp mạng/VM.
- **Mức 64 với 4 tenant không ổn định**, lặp lại ở hai lần chạy: 50,3 rồi 19,0/s; lần chạy lại 2,3/s (38 timeout) và 13,2/s. Khi sụp,
  Node gần như rảnh (CPU 12–39%, trễ vòng lặp p50 3–6 ms), CPU SQL giảm (50–57%), mọi mẫu bị chặn vẫn là `LCK_M_U` trên 4 dòng MERCHANT
  nhưng mỗi lần chờ kéo dài ~5–11 s. Nguyên nhân chưa xác định; với 1 tenant và 64 luồng hiện tượng này không xảy ra.
- Bất thường của số đo: ở các lượt này, tổng `LCK_M_U` của `sys.dm_os_wait_stats` có lúc vượt số luồng × độ dài khoảng đo (vd `t1` mức
  16: 476–478 s trong ~23,3 s với 16 luồng; `t4` mức 64: 4 550 s trong 24 s), điều không thể nếu mỗi luồng chỉ chờ một khóa một lúc. Vì vậy
  con số "số luồng đang chờ" suy từ tổng chờ (bảng baseline) chỉ nên coi là gần đúng; bằng chứng xếp hàng dựa trên **mẫu** câu lệnh bị chặn
  vẫn giữ nguyên.
- **Hệ quả cho ước lượng bậc 1:** ước lượng thô 150–250/s trước đây **không còn giá trị trên máy này**: ngay cả với 4 dòng MERCHANT độc lập
  (tương đương đoạn giữ khóa mỗi dòng ngắn đi nhiều) máy chỉ cho ~70–90 thao tác/s ở 16 luồng. Mọi số đo của bậc 1 trên máy dev này sẽ bị
  giới hạn dùng chung chặn ở khoảng ×1,2–1,7 so với hiện tại, không phản ánh được lợi ích trên phần cứng khác.

## Điểm dừng — quyết định cho Pha B

**Số liệu then chốt** (máy `DESKTOP-MBR3422`, 1 tenant):

- Trần trả order: **~50–53 thao tác/s**, bão hòa từ **4 luồng**; một luồng 37,6/s. Trần nạp tiền cùng cỡ (~55–58/s).
- Thời gian giữ khóa MERCHANT **suy ra** (1 / thông lượng, không đo) ≈ **19 ms** mỗi transaction; ghi log commit chỉ ~0,7 ms trong đó;
  phần còn lại chưa đo và rất nhạy với tải của máy (gấp ~2,5–3 lần khi có tải nền).
- Trên trần, độ trễ tăng tuyến tính theo số luồng: p99 **180 ms** (4 luồng), **499 ms** (16), **2 087 ms** (64).
- 100% chờ `LCK_M_U` nằm trên **một** khóa (`system:MERCHANT:VND` / `system:GATEWAY:VND`), tại câu lệnh `lockMany`; không có chờ trên
  kiểm khóa ngoại `ledger_entries` với thứ tự khóa hiện tại; chờ trên dòng ví gần như không có.
- Đầu-cuối: 14 đơn/s ở 16 luồng, thấp hơn trần MERCHANT ~3,8 lần.
- Đo bổ sung: 2 / 4 dòng MERCHANT (tenant) cho thông lượng tổng ~60 / ~70–90 thao tác/s ở 16 luồng (×1,2 / ×1,4–1,7, không tuyến tính);
  bộ sinh tải không bão hòa (Node ≤ 63% một lõi, trễ vòng lặp p50 ≤ 0,5 ms); 64 luồng × 4 tenant thì sụp (timeout).

**Hướng vá bậc 1 phù hợp với số đo** (chưa làm; cần spec/kế hoạch riêng của Pha B và đo lại bằng chính bộ đo này):

1. **Thu ngắn đoạn giữ khóa MERCHANT**: với 1 tenant, hệ thống tuần tự hóa trên dòng này nên trần ≈ 1 / thời gian giữ. Khóa MERCHANT **muộn nhất có thể** (sau khi đã khóa ví,
   trừ tiền ví, ghi `order_payments`/outbox), để đoạn giữ chỉ còn cập nhật số dư MERCHANT, dòng sổ cái của nó và commit.
2. **Thứ tự khóa toàn hệ thống: ví khách trước, tài khoản hệ thống sau** (áp dụng đồng thời cho `PayOrder`, `ApplyPaymentResult`,
   `ReverseTransaction`, `AdjustWallet` để không tạo deadlock mới); đây là điều kiện để làm được hướng 1.
3. **Không đọc dòng tài khoản hệ thống bằng khóa `S` trước khi khóa** (vd `findTransaction` của đảo giao dịch đang JOIN `accounts`), vì
   số đo cho thấy lệnh đọc đó xếp hàng sau người giữ khóa.
4. Khi đã đổi thứ tự, **đo lại H2**: nếu `insert into ledger_entries` bắt đầu chờ `LCK_M_S` trên dòng MERCHANT thì kiểm khóa ngoại kéo
   đoạn chờ trở lại; khi đó mới cân nhắc cách ghi dòng sổ cái MERCHANT trong cùng đoạn giữ khóa.

**Bậc 2 (chia nhỏ số dư MERCHANT) có thể cần không?** Số đo cho thấy hệ thống tuần tự hoàn toàn trên một dòng (khoảng N − 2 luồng luôn chờ),
nên mọi vá bậc 1 chỉ dời trần lên tới 1 / (thời gian giữ còn lại), không bỏ được trần. Bao nhiêu thì đủ phụ thuộc thời gian giữ sau bậc 1,
Pha A **không** đo được con số này. Ước lượng thô trước đây (150–250/s) **đã bị phép đo bổ sung bác bỏ trên máy này**: chia tải ra 4 dòng
MERCHANT độc lập (một dạng "bậc 2" lý tưởng) chỉ đưa thông lượng tổng lên ~70–90/s ở 16 luồng, vì một giới hạn dùng chung của máy (chưa
xác định: CPU SQL trong VM, CPU máy hay lớp mạng Docker) chặn ngay phía trên. Hệ quả:

- Trên máy dev này, **cả bậc 1 lẫn bậc 2** đều chỉ có thể cho thấy mức tăng tối đa cỡ ×1,2–1,7; số đo ở đây không đủ để biết bậc 1 hay bậc 2
  đáng làm trên phần cứng thật.
- Cùng bộ đo, chạy với `PERF_TENANTS` > 1 là cách rẻ để đo giới hạn dùng chung đó trên một máy khác trước khi quyết định.
- Ở mức 64 luồng với 4 dòng, hệ thống sụp (timeout); trước khi tăng song song (bậc 2 hoặc nhiều tenant thật) cần hiểu hiện tượng này.

**Lưu ý cho bộ đo ở Pha B:** hàng đợi topup của `topup-apply`/`mixed` được cấp theo `TOTAL_OPS_PER_SEC = 120` (× `SAFETY_FACTOR` 1,25 ≈
150 thao tác/s) trong `tests/perf/support/runner.ts`. Nếu vá bậc 1 đẩy thông lượng lên gần hoặc vượt mức đó, hai kịch bản này sẽ dừng với
lỗi "hàng đợi topup cạn" (cố ý, không đo sai): khi đó phải nâng hai hằng số trước khi đo.

**Câu hỏi cần người dùng trả lời** (Pha A không tự chốt ngưỡng):

1. Ngưỡng thông lượng trả order mục tiêu **cho một tenant, một đồng tiền** là bao nhiêu (thao tác/s ở giờ cao điểm, kèm hệ số dự phòng)?
   So với trần ~50–53/s đo trên máy dev, mức đó đã cần vá chưa?
2. Ngưỡng độ trễ chấp nhận được (p95/p99 của một lần trả order) ở mức tải đó là bao nhiêu? Trên trần, p99 tăng ~19 ms cho mỗi luồng đồng
   thời thêm vào.
3. Nạp tiền (GATEWAY, trần cùng cỡ) có cùng ngưỡng không, hay chỉ trả order là ưu tiên?
4. Có cần đo trên phần cứng giống production (hoặc SQL Server không qua Docker Desktop) trước khi chốt? Đo bổ sung cho thấy máy dev có
   một giới hạn dùng chung chỉ cao hơn trần MERCHANT ~1,2–1,7 lần, nên **mọi** vá ở Pha B đo trên máy này sẽ bị giới hạn đó che; nếu đồng
   ý, chạy lại `pay-order` với `PERF_TENANTS=1,2,4` trên máy đó trước.
5. Có cần điều tra hiện tượng sụp ở 64 luồng × 4 tenant (timeout, mỗi lần chờ khóa 5–11 s) trước Pha B không, hay ngoài phạm vi?
6. Nếu cần vá: đồng ý phạm vi bậc 1 (đổi thứ tự khóa toàn hệ thống + khóa MERCHANT muộn nhất + bỏ đọc khóa `S` trước khi khóa) cho Pha B,
   với điều kiện dừng là đạt ngưỡng ở câu 1–2 trên chính bộ đo này?
7. Có cần đo lại `topup-apply` khi máy rảnh hẳn (mức 4 và 16 của baseline còn nhiễu) trước Pha B không?
