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
| 1 | 30,8 (29,2–33,3) | 56,4 | 98,7 | 0 |
| 4 | 40,9 (23,9–41,2) ⚠ lần 3 | 146,9 | 209,1 | 0 |
| 16 | 19,3 (8,2–25,8) ⚠ | 3 025,6 | 3 918,3 | 0 |
| 64 | 54,5 (42,8–57,1) ⚠ lần 1 | 1 620,6 | 1 676,1 | 0 |

Lượt 2 của `topup-apply` nhiễu nặng hơn (mức 16: 8,8/s, 8 timeout; mức 64: 18,5/s). Lượt hiệu chuẩn 8 s trước đó (máy rảnh) đo
43,0 / 58,5 / 51,4 thao tác/s ở 1 / 16 / 64 luồng: trần GATEWAY cùng cỡ với trần MERCHANT.

**`mixed`** (70% trả order / 15% nạp / 10% điều chỉnh / 5% đảo; lượt 1, sạch):

| Mức | Thông lượng/s (min–max) | p95 | p99 | Lỗi |
| --- | ----------------------- | --- | --- | --- |
| 1 | 37,1 (36,5–38,7) | 45,0 | 65,8 | 0 |
| 4 | 48,1 (47,7–60,9) | 132,9 | 177,9 | 0 |
| 16 | 49,4 (47,5–49,4) | 618,4 | 767,7 | 0 |
| 64 | 40,4 (38,5–46,3) | 3 461,5 | 4 818,4 | 0 |

**Đầu-cuối** (200 đơn, 16 luồng gửi; lượt 1, khoảng rảnh): **14,0 đơn/s**, p50 / p95 / p99 = 1 095 / 1 431 / 1 487 ms, bất biến đạt.
(Lượt 2, bị Postman tải nền: 8,2 đơn/s, p99 4 318 ms.)

**Để so sánh, `pay-order` của lượt 1 (nhiễu):** 31,3 / 42,7 / 19,9 ⚠ / 17,2 ⚠ thao tác/s ở 1 / 4 / 16 / 64 luồng.

### Chờ khóa và câu lệnh bị chặn

`pay-order` (lượt 2): `LCK_M_*` trong mỗi lượt chỉ gồm `LCK_M_U` (và vài `LCK_M_S` vài ms):

| Mức | Tổng chờ `LCK_M_U` mỗi lượt (s) | Số lần chờ / số thao tác đã bắt đầu | Chờ TB mỗi lần (ms) | Số luồng đang chờ khóa TB (tổng chờ / độ dài cửa sổ) |
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
hai lượt; cũng không có mẫu nào chờ trên dòng ví. Trong `mixed`, `LCK_M_S` mỗi lượt là 1,6–1,7 s (mức 4), 15–26 s (mức 16), 78–96 s
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

Tách thời gian một thao tác `pay-order`: một luồng mất 1 / 37,6 ≈ **26,6 ms** mỗi thao tác; ở trần, cứ 1 / 52,8 ≈ **18,9 ms** mới xong
một thao tác. Vì bảng chờ cho thấy cả hệ thống xếp hàng trên một dòng (mục 3), 18,9 ms là thời gian giữ khóa MERCHANT trung bình mỗi
transaction, tức **~71%** thời gian của thao tác nằm trong đoạn giữ khóa; phần ngoài khóa (~7,7 ms) chỉ cho phép tối đa 26,6 / 18,9 ≈
1,41 lần tăng tốc, đúng với 1,34–1,40 lần đo được ở mức 4. Đối chiếu với code `PayOrder` (đọc code, không đo): trước khi khóa MERCHANT
có khoảng 3–4 lượt đi-về (inbox, tìm order đã trả, đọc ví), sau khi khóa có khoảng 8–9 (khóa ví, 2 `UPDATE` số dư, 2 `INSERT` sổ cái,
`order_payments`, outbox, commit): tỉ lệ ~2/3 khớp với 71%.

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
- Hàng đợi gần như đầy: tổng chờ `LCK_M_U` chia độ dài cửa sổ cho thấy ≈2,4/4, ≈14,3/16 và ≈60/64 luồng luôn đang chờ, và mỗi
  thao tác chờ đúng một lần (số lần chờ ≈ số thao tác). Chờ trung bình mỗi lần ≈ (số luồng − 1) × 18,9 ms.
- **Không** có mẫu nào của `insert into ledger_entries` (kiểm khóa ngoại `account_id → accounts`) hay `update accounts` bị chặn, và không
  có chờ trên dòng ví (khách chọn ngẫu nhiên trong 2 000 nên hầu như không trùng).
- Trong `mixed`, ngoài `lockMany`, có một câu lệnh **đọc** xếp hàng trên dòng MERCHANT: `findTransaction` của `ReverseTransaction` đọc
  `ledger_entries` JOIN `accounts` (database dùng read committed có khóa nên lệnh đọc lấy `S` trên dòng MERCHANT) **trước** khi gọi
  `lockMany`; 2 786 mẫu, tất cả trên MERCHANT, chờ TB 1,6–2,2 s ở mức 64.
- `WRITELOG` ~0,7 ms mỗi commit, một lần mỗi thao tác: ở trần 52,8/s, ghi log chiếm 52,8 × 0,7 ≈ 37 ms mỗi giây (~4%) của đoạn giữ khóa
  nối tiếp. Phần còn lại của 18,9 ms không hiện thành chờ phía server nào trong bảng: đó là thời gian session giữ khóa trong lúc không
  chạy câu lệnh nào (đi-về giữa Node và SQL Server qua Docker Desktop, xử lý ở Node). Đây là suy luận từ việc thiếu loại chờ khác, không
  phải số đo trực tiếp từng câu lệnh.

### 4. Nhận định giả thuyết

| | Giả thuyết | Kết luận | Bằng chứng |
| - | ---------- | -------- | ---------- |
| H1 | Thông lượng trả order bị chặn trên bởi thời gian giữ khóa dòng MERCHANT; thứ tự khóa (MERCHANT trước) kéo dài thời gian giữ | **ĐÚNG** (phần "bị chặn bởi thời gian giữ"); phần "thứ tự khóa kéo dài": **đúng về cơ chế, độ lớn chưa đo** | Trần 52,8/s = 1 / 18,9 ms; 100% mẫu chờ trên `KEY (b8079320b67d)` = MERCHANT; ~14,3/16 và ~60/64 luồng luôn đang chờ; tăng tốc tối đa 1,4 lần đúng như tách 18,9 / 26,6 ms. Vì MERCHANT bị khóa trước, đoạn giữ gồm cả lượt khóa ví và mọi câu lệnh sau đó (~8–9 lượt đi-về theo code); bộ đo không đo thời gian từng câu lệnh nên không tách được riêng phần do thứ tự khóa |
| H2 | Kiểm khóa ngoại `ledger_entries → accounts` xếp hàng trên dòng MERCHANT dù khóa muộn | **CHƯA KẾT LUẬN** | 0 mẫu `insert into ledger_entries` bị chặn trong mọi kịch bản: với thứ tự hiện tại, transaction đã giữ khóa MERCHANT trước khi chèn nên kiểm khóa ngoại không phải chờ ai; giả thuyết nói về thiết kế sau khi đổi thứ tự, không quan sát được nếu không đổi code. Chỉ dấu liên quan: lệnh **đọc** dòng MERCHANT (`findTransaction`, `LCK_M_S`, 2 786 mẫu, 1,6–2,2 s mỗi lần ở mức 64) có xếp hàng sau người giữ khóa, nên một lệnh cần khóa `S` trên dòng MERCHANT (như kiểm khóa ngoại) nhiều khả năng cũng sẽ xếp hàng; Pha B phải đo lại sau khi đổi thứ tự |
| H3 | Ở nhiều luồng, `LCK_M_*` và p99 tăng nhanh hơn thông lượng | **ĐÚNG** | 4 → 64 luồng: thông lượng −1% (50,5 → 49,8), tổng chờ `LCK_M_U` ×26 (57 s → 1 460 s mỗi lượt), p99 ×11,6 (180 → 2 087 ms); 1 → 64 luồng: thông lượng ×1,32, p99 ×38. Dạng tăng là của một hàng đợi đơn (luật Little), không phải sụp đổ: không deadlock, không timeout khi máy rảnh |

### 5. So sánh các kịch bản

- **`pay-order` và `topup-apply`** có cùng hình dạng và cùng cỡ trần (~50–58/s), mỗi bên một dòng nóng (MERCHANT, GATEWAY). Nút cổ chai
  không riêng gì MERCHANT: mọi luồng ghi đi qua một dòng tài khoản hệ thống của (tenant, đồng tiền) đều có trần này.
- **`mixed`** không cao hơn `pay-order` dù 15% thao tác (nạp tiền) đi qua GATEWAY, một dòng khác, và 10% (điều chỉnh) qua ADJUSTMENT:
  ở trần 49,4/s chỉ ~37/s là trả order hoặc đảo (đi qua MERCHANT), thấp hơn trần 52,8/s của riêng `pay-order`, trong khi 99,5% mẫu
  `LCK_M_U` vẫn nằm trên MERCHANT. Số đo cho thấy trong `mixed` dòng MERCHANT bị giữ lâu hơn hoặc bị chặn thêm (lệnh đảo đọc dòng MERCHANT
  trước khi khóa, `WRITELOG` TB 1,6–2,8 ms và 1,06–1,26 lần mỗi thao tác so với 0,7 ms và 1,00 của `pay-order`), nhưng không tách được
  phần nào là do đâu. `mixed` cũng là kịch bản duy nhất giảm rõ ở 64 luồng (−18%).
- **Đầu-cuối** chỉ đạt 14,0 đơn/s ở 16 luồng, ~3,8 lần dưới trần `pay-order` (52,8/s) cùng mức; p50 1 095 ms đúng bằng 16 / 14,0 s. Với
  harness này (broker, relay outbox theo lô, Orders giả trong cùng tiến trình), MERCHANT **không phải** nút cổ chai của đường đầu-cuối ở
  200 đơn × 16 luồng. Bộ đo không chụp chờ khóa cho phần đầu-cuối nên không nói được nút cổ chai ở đâu.

### 6. Trần commit/ghi log hay khóa MERCHANT?

Canary (Task 3) đo được ~390–425 `UPDATE` tự commit/giây với 8 luồng trên 8 dòng khác nhau trên máy này, cao gấp ~8 lần trần
`pay-order`; `WRITELOG` mỗi commit của `pay-order` chỉ 0,66–0,80 ms. Nếu trần là độ trễ commit, thông lượng phải tăng tiếp khi thêm luồng
(commit của các transaction khác nhau không phải chờ nhau), nhưng thực tế bằng phẳng từ mức 4 và mọi luồng thừa nằm trong hàng
đợi `LCK_M_U` của **một** khóa. Kết luận: trần hiện tại là **khóa MERCHANT** (thời gian giữ ~18,9 ms), trong đó ghi log commit chiếm ~4%;
không phải sàn commit.

### 7. Giới hạn

- Máy dev Windows + Docker Desktop (VM WSL2), 4 CPU dùng chung cho bộ sinh tải Node, SQL Server và mọi ứng dụng khác; đi-về Node ↔ SQL
  Server đi qua lớp mạng của Docker Desktop. Số tuyệt đối **không** đại diện cho production; chỉ so sánh số đo cùng nhãn máy.
- Hai lượt đều có tải nền ở một phần thời gian (bảng trên); baseline ghép mỗi kịch bản từ lượt sạch hơn, `topup-apply` mức 4 và 16 vẫn
  còn nhiễu. Nên đo lại khi máy rảnh hẳn (đóng Postman, cửa sổ Docker Desktop, dừng tải nền) trước khi dùng `topup-apply` làm mốc.
- Vòng kín, không phải tốc độ đến cố định: độ trễ ở mức cao chủ yếu là thời gian xếp hàng do chính bộ đo tạo ra; không nói được độ trễ
  ở một tốc độ đến cụ thể (đó là việc của đo kiểu mở ở Pha B nếu cần).
- Một tenant, một đồng tiền (VND): mỗi (tenant, đồng tiền) có dòng MERCHANT riêng nên trần đo được là **trần của một tenant**; nhiều tenant
  chưa đo.
- Bộ đo use case gọi thẳng use case, không qua broker/HTTP; đầu-cuối chỉ một cấu hình (200 đơn, 16 luồng) và không có bảng chờ khóa.
- Không đo thời gian từng câu lệnh trong đoạn giữ khóa; các con số lượt đi-về lấy từ đọc code.

## Điểm dừng — quyết định cho Pha B

**Số liệu then chốt** (máy `DESKTOP-MBR3422`, 1 tenant):

- Trần trả order: **~50–53 thao tác/s**, bão hòa từ **4 luồng**; một luồng 37,6/s. Trần nạp tiền cùng cỡ (~55–58/s).
- Thời gian giữ khóa MERCHANT ≈ **18,9 ms** mỗi transaction, ~71% thời gian của một lần trả order; ghi log commit chỉ ~0,7 ms trong đó.
- Trên trần, độ trễ tăng tuyến tính theo số luồng: p99 **180 ms** (4 luồng), **499 ms** (16), **2 087 ms** (64).
- 100% chờ khóa nằm trên **một** khóa (`system:MERCHANT:VND` / `system:GATEWAY:VND`), tại câu lệnh `lockMany`; không có chờ trên kiểm khóa
  ngoại `ledger_entries` với thứ tự khóa hiện tại.
- Đầu-cuối: 14 đơn/s ở 16 luồng, thấp hơn trần MERCHANT ~3,8 lần.

**Hướng vá bậc 1 phù hợp với số đo** (chưa làm; cần spec/kế hoạch riêng của Pha B và đo lại bằng chính bộ đo này):

1. **Thu ngắn đoạn giữ khóa MERCHANT**: số đo cho thấy trần = 1 / thời gian giữ. Khóa MERCHANT **muộn nhất có thể** (sau khi đã khóa ví,
   trừ tiền ví, ghi `order_payments`/outbox), để đoạn giữ chỉ còn cập nhật số dư MERCHANT, dòng sổ cái của nó và commit.
2. **Thứ tự khóa toàn hệ thống: ví khách trước, tài khoản hệ thống sau** (áp dụng đồng thời cho `PayOrder`, `ApplyPaymentResult`,
   `ReverseTransaction`, `AdjustWallet` để không tạo deadlock mới); đây là điều kiện để làm được hướng 1.
3. **Không đọc dòng tài khoản hệ thống bằng khóa `S` trước khi khóa** (vd `findTransaction` của đảo giao dịch đang JOIN `accounts`), vì
   số đo cho thấy lệnh đọc đó xếp hàng sau người giữ khóa.
4. Khi đã đổi thứ tự, **đo lại H2**: nếu `insert into ledger_entries` bắt đầu chờ `LCK_M_S` trên dòng MERCHANT thì kiểm khóa ngoại kéo
   đoạn chờ trở lại; khi đó mới cân nhắc cách ghi dòng sổ cái MERCHANT trong cùng đoạn giữ khóa.

**Bậc 2 (chia nhỏ số dư MERCHANT) có thể cần không?** Số đo cho thấy hệ thống tuần tự hoàn toàn trên một dòng (~14,3/16 luồng luôn chờ),
nên mọi vá bậc 1 chỉ dời trần lên tới 1 / (thời gian giữ còn lại), không bỏ được trần. Bao nhiêu thì đủ phụ thuộc thời gian giữ sau bậc 1,
Pha A **không** đo được con số này. Một ước lượng thô chỉ để định hướng (giả định, không phải số đo): ~9 lượt đi-về trong 18,9 ms là ~2 ms
mỗi lượt; nếu đoạn giữ còn 2–3 lượt đi-về thì trần cỡ 150–250/s trên máy này. Bậc 2 chỉ có ý nghĩa nếu ngưỡng cần đạt cao hơn mức đó **và**
số đo sau bậc 1 xác nhận. Với nhiều tenant, mỗi tenant có MERCHANT riêng nên trần là theo tenant.

**Câu hỏi cần người dùng trả lời** (Pha A không tự chốt ngưỡng):

1. Ngưỡng thông lượng trả order mục tiêu **cho một tenant, một đồng tiền** là bao nhiêu (thao tác/s ở giờ cao điểm, kèm hệ số dự phòng)?
   So với trần ~50–53/s đo trên máy dev, mức đó đã cần vá chưa?
2. Ngưỡng độ trễ chấp nhận được (p95/p99 của một lần trả order) ở mức tải đó là bao nhiêu? Trên trần, p99 tăng ~19 ms cho mỗi luồng đồng
   thời thêm vào.
3. Nạp tiền (GATEWAY, trần cùng cỡ) có cùng ngưỡng không, hay chỉ trả order là ưu tiên?
4. Có cần đo trên phần cứng giống production (hoặc SQL Server không qua Docker Desktop) trước khi chốt, vì số tuyệt đối ở đây phụ thuộc
   độ trễ đi-về của máy dev?
5. Nếu cần vá: đồng ý phạm vi bậc 1 (đổi thứ tự khóa toàn hệ thống + khóa MERCHANT muộn nhất + bỏ đọc khóa `S` trước khi khóa) cho Pha B,
   với điều kiện dừng là đạt ngưỡng ở câu 1–2 trên chính bộ đo này?
6. Có cần đo lại `topup-apply` khi máy rảnh hẳn (mức 4 và 16 của baseline còn nhiễu) trước Pha B không?
