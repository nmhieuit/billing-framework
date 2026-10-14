# Báo cáo hiệu năng

- Thời điểm: 2026-10-14T03:06:27.056Z
- Máy: DESKTOP-MBR3422 (4 CPU, 31.9 GB RAM, Node v22.20.0, Windows_NT 10.0.22000 x64)
- SQL Server: Microsoft SQL Server 2022 (RTM-CU26) (KB5093420) - 16.0.4265.3 (X64)
- Git: ac664387dc357324755330b0988308d405399116
- Hợp lệ: có

## Kịch bản: pay-order

Mỗi thao tác trả một order 1 000 VND cho một khách ngẫu nhiên: mọi lệnh cùng khóa tài khoản MERCHANT (điểm nóng).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 37.6 | 36.7–37.7 | 39.9 | 54.5 | 0 |
| 4 | 50.5 | 50.1–53.5 | 129.1 | 180.1 | 0 |
| 16 | 52.8 | 51.6–52.8 | 442.4 | 499.3 | 0 |
| 64 | 49.8 | 47.5–53.0 | 1893.7 | 2086.5 | 0 |

## Kịch bản: topup-apply

Mỗi thao tác áp kết quả charge.succeeded cho một topup PENDING chưa dùng (hàng đợi seed trước, ngoài cửa sổ đo).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 26.4 | 9.3–32.5 | 66.1 | 100.2 | 0 |
| 4 | 44.1 | 39.2–45.6 | 143.1 | 190.5 | 0 |
| 16 | 8.8 | 1.4–17.1 | 3347.2 | 4405.0 | 8 |
| 64 | 18.5 | 8.2–21.6 | 6794.8 | 8143.3 | 0 |

## Kịch bản: mixed

Hỗn hợp: 70% trả order, 15% áp nạp tiền, 10% điều chỉnh CREDIT ví, 5% đảo một giao dịch ORDER_PAYMENT đã tạo trong lượt (chưa có thì trả order thay).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 6.8 | 4.8–9.1 | 419.2 | 971.5 | 0 |
| 4 | 11.7 | 6.7–16.9 | 1095.2 | 1541.1 | 0 |
| 16 | 10.2 | 1.3–16.8 | 4660.4 | 5462.6 | 1 |
| 64 | 16.9 | 12.2–34.5 | 8110.8 | 9497.5 | 0 |

## Chờ khóa nổi bật

### pay-order

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 50938 | KEY: 5:72057594045857792 (b8079320b67d) (50938) |
| LCK_M_S | select * from "t_perf1"."accounts" where "id" = @1 | 2 | KEY: 5:72057594045857792 (fb2a164d09af) (1); KEY: 5:72057594045857792 (0c23f333af1c) (1) |

### topup-apply

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 38528 | KEY: 5:72057594045857792 (49950b0e6a67) (38528) |

### mixed

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 36747 | KEY: 5:72057594045857792 (b8079320b67d) (36427); KEY: 5:72057594045857792 (49950b0e6a67) (258); KEY: 5:72057594045857792 (4334da4a7f50) (62) |
| LCK_M_S | select "e"."account_id", "e"."amount", "a"."currency" from "t_perf1"."ledger_entries" as "e" inner join "t_perf1"."accou | 1964 | KEY: 5:72057594045857792 (b8079320b67d) (1964) |
| PAGELATCH_EX | insert into "t_perf1"."ledger_entries" ("transaction_id", "account_id", "amount", "created_at") values (@1, @2, @3, cast | 1 | 5:1:18545 (1) |
| PAGELATCH_SH | select "e"."account_id", "e"."amount", "a"."currency" from "t_perf1"."ledger_entries" as "e" inner join "t_perf1"."accou | 1 | 5:1:19079 (1) |

## End-to-end

- Số đơn: 200
- Mức đồng thời: 16
- Thông lượng/giây: 8.2
- p50 / p95 / p99 (ms): 1606.7 / 3568.0 / 4318.1
- Bất biến: đạt

## Ghi chú

- kịch bản pay-order, mức 1, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản pay-order, mức 1, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản pay-order, mức 1, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản pay-order, mức 4, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản pay-order, mức 4, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản pay-order, mức 4, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản pay-order, mức 16, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản pay-order, mức 16, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản pay-order, mức 16, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản pay-order, mức 64, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản pay-order, mức 64, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản pay-order, mức 64, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 0.0 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản pay-order, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 866 thao tác đã bắt đầu): WRITELOG 620 ms/895 lần (TB 0.69 ms/lần, 1.03 lần/thao tác); SOS_SCHEDULER_YIELD 2 ms/32 lần (TB 0.06 ms/lần, 0.04 lần/thao tác)
- kịch bản pay-order, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.3 s, 870 thao tác đã bắt đầu): WRITELOG 664 ms/873 lần (TB 0.76 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 7 ms/44 lần (TB 0.16 ms/lần, 0.05 lần/thao tác)
- kịch bản pay-order, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 846 thao tác đã bắt đầu): WRITELOG 651 ms/848 lần (TB 0.77 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 5 ms/25 lần (TB 0.20 ms/lần, 0.03 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1152 thao tác đã bắt đầu): WRITELOG 853 ms/1156 lần (TB 0.74 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 18 ms/46 lần (TB 0.39 ms/lần, 0.04 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1231 thao tác đã bắt đầu): WRITELOG 834 ms/1231 lần (TB 0.68 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 18 ms/44 lần (TB 0.41 ms/lần, 0.04 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1173 thao tác đã bắt đầu): WRITELOG 878 ms/1179 lần (TB 0.74 ms/lần, 1.01 lần/thao tác); PAGELATCH_SH 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 55 ms/61 lần (TB 0.90 ms/lần, 0.05 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.3 s, 1218 thao tác đã bắt đầu): WRITELOG 810 ms/1222 lần (TB 0.66 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGEIOLATCH_EX 2 ms/1 lần (TB 2.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 55 ms/63 lần (TB 0.87 ms/lần, 0.05 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.4 s, 1190 thao tác đã bắt đầu): WRITELOG 838 ms/1192 lần (TB 0.70 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 30 ms/74 lần (TB 0.41 ms/lần, 0.06 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 1232 thao tác đã bắt đầu): WRITELOG 866 ms/1233 lần (TB 0.70 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 8 ms/37 lần (TB 0.22 ms/lần, 0.03 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.5 s, 1255 thao tác đã bắt đầu): WRITELOG 847 ms/1255 lần (TB 0.67 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 1 ms/4 lần (TB 0.25 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 249 ms/120 lần (TB 2.08 ms/lần, 0.10 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.3 s, 1166 thao tác đã bắt đầu): WRITELOG 944 ms/1175 lần (TB 0.80 ms/lần, 1.01 lần/thao tác); ASYNC_NETWORK_IO 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_EX 1 ms/7 lần (TB 0.14 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 1 ms/9 lần (TB 0.11 ms/lần, 0.01 lần/thao tác); PAGEIOLATCH_SH 1 ms/1 lần (TB 1.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 208 ms/202 lần (TB 1.03 ms/lần, 0.17 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.4 s, 1221 thao tác đã bắt đầu): WRITELOG 894 ms/1226 lần (TB 0.73 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGEIOLATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 95 ms/172 lần (TB 0.55 ms/lần, 0.14 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 22.7 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 1: 1823 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 30.9 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 2: 1978 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 74.6 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 3: 2357 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 65.6 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 1: 2399 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 30.7 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 2: 2442 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 33.3 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 3: 2557 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 184.0 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 1: 3103 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 141.1 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 2: 3186 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 156.8 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 3: 3406 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 234.5 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 1: 3027 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 324.4 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 2: 3340 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 158.8 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 3: 3077 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 767 thao tác đã bắt đầu): WRITELOG 655 ms/782 lần (TB 0.84 ms/lần, 1.02 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGEIOLATCH_SH 3 ms/2 lần (TB 1.50 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 4 ms/93 lần (TB 0.04 ms/lần, 0.12 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.3 s, 612 thao tác đã bắt đầu): WRITELOG 659 ms/619 lần (TB 1.06 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 41 ms/118 lần (TB 0.35 ms/lần, 0.19 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.2 s, 233 thao tác đã bắt đầu): WRITELOG 1104 ms/253 lần (TB 4.36 ms/lần, 1.09 lần/thao tác); PAGELATCH_EX 0 ms/6 lần (TB 0.00 ms/lần, 0.03 lần/thao tác); PAGELATCH_SH 0 ms/6 lần (TB 0.00 ms/lần, 0.03 lần/thao tác); SOS_SCHEDULER_YIELD 467 ms/618 lần (TB 0.76 ms/lần, 2.65 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1059 thao tác đã bắt đầu): WRITELOG 850 ms/1061 lần (TB 0.80 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 27 ms/70 lần (TB 0.39 ms/lần, 0.07 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1016 thao tác đã bắt đầu): WRITELOG 816 ms/1018 lần (TB 0.80 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 59 ms/135 lần (TB 0.44 ms/lần, 0.13 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.6 s, 901 thao tác đã bắt đầu): WRITELOG 850 ms/906 lần (TB 0.94 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 73 ms/167 lần (TB 0.44 ms/lần, 0.19 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 27.0 s, 379 thao tác đã bắt đầu): WRITELOG 2598 ms/520 lần (TB 5.00 ms/lần, 1.37 lần/thao tác); PAGELATCH_EX 1 ms/6 lần (TB 0.17 ms/lần, 0.02 lần/thao tác); PAGELATCH_SH 11 ms/8 lần (TB 1.38 ms/lần, 0.02 lần/thao tác); SOS_SCHEDULER_YIELD 1932 ms/600 lần (TB 3.22 ms/lần, 1.58 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 27.2 s, 296 thao tác đã bắt đầu): WRITELOG 1228 ms/310 lần (TB 3.96 ms/lần, 1.05 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1416 ms/616 lần (TB 2.30 ms/lần, 2.08 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 37.0 s, 76 thao tác đã bắt đầu): WRITELOG 3191 ms/86 lần (TB 37.10 ms/lần, 1.13 lần/thao tác); PAGELATCH_EX 1 ms/3 lần (TB 0.33 ms/lần, 0.04 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.04 lần/thao tác); SOS_SCHEDULER_YIELD 10358 ms/560 lần (TB 18.50 ms/lần, 7.37 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 28.7 s, 551 thao tác đã bắt đầu): WRITELOG 1221 ms/563 lần (TB 2.17 ms/lần, 1.02 lần/thao tác); PAGELATCH_EX 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 11 ms/6 lần (TB 1.83 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1943 ms/558 lần (TB 3.48 ms/lần, 1.01 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 29.4 s, 238 thao tác đã bắt đầu): WRITELOG 1323 ms/253 lần (TB 5.23 ms/lần, 1.06 lần/thao tác); PAGELATCH_EX 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 7 ms/1 lần (TB 7.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 4880 ms/861 lần (TB 5.67 ms/lần, 3.62 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 25.2 s, 501 thao tác đã bắt đầu): WRITELOG 1137 ms/515 lần (TB 2.21 ms/lần, 1.03 lần/thao tác); PAGELATCH_SH 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 1043 ms/375 lần (TB 2.78 ms/lần, 0.75 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 5.8 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 141 (72.3%, trong đó 0 trả thay cho đảo), nạp 35 (17.9%), điều chỉnh 9 (4.6%), đảo 10 (5.1%); 433 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 47.1 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 107 (75.4%, trong đó 0 trả thay cho đảo), nạp 19 (13.4%), điều chỉnh 7 (4.9%), đảo 9 (6.3%); 449 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 16.6 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 92 (65.7%, trong đó 0 trả thay cho đảo), nạp 26 (18.6%), điều chỉnh 13 (9.3%), đảo 9 (6.4%); 442 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 135.2 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 109 (76.8%, trong đó 0 trả thay cho đảo), nạp 21 (14.8%), điều chỉnh 5 (3.5%), đảo 7 (4.9%); 606 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 12.1 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 211 (74.0%, trong đó 1 trả thay cho đảo), nạp 32 (11.2%), điều chỉnh 18 (6.3%), đảo 24 (8.4%); 595 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 13.0 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 247 (69.4%, trong đó 0 trả thay cho đảo), nạp 60 (16.9%), điều chỉnh 36 (10.1%), đảo 13 (3.7%); 567 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 15.7 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 247 (67.5%, trong đó 1 trả thay cho đảo), nạp 53 (14.5%), điều chỉnh 52 (14.2%), đảo 14 (3.8%); 590 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 36.1 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 27 (69.2%, trong đó 0 trả thay cho đảo), nạp 5 (12.8%), điều chỉnh 5 (12.8%), đảo 2 (5.1%); 638 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 110.8 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 173 (72.7%, trong đó 0 trả thay cho đảo), nạp 34 (14.3%), điều chỉnh 23 (9.7%), đảo 8 (3.4%); 609 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 33.0 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 289 (68.5%, trong đó 3 trả thay cho đảo), nạp 60 (14.2%), điều chỉnh 43 (10.2%), đảo 30 (7.1%); 649 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 12.6 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 556 (70.9%, trong đó 2 trả thay cho đảo), nạp 119 (15.2%), điều chỉnh 78 (9.9%), đảo 31 (4.0%); 590 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 15.2 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 263 (69.8%, trong đó 1 trả thay cho đảo), nạp 61 (16.2%), điều chỉnh 41 (10.9%), đảo 12 (3.2%); 648 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 26.4 s, 195 thao tác đã bắt đầu): WRITELOG 562 ms/197 lần (TB 2.85 ms/lần, 1.01 lần/thao tác); SOS_SCHEDULER_YIELD 1560 ms/359 lần (TB 4.35 ms/lần, 1.84 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.7 s, 142 thao tác đã bắt đầu): WRITELOG 988 ms/144 lần (TB 6.86 ms/lần, 1.01 lần/thao tác); SOS_SCHEDULER_YIELD 244 ms/254 lần (TB 0.96 ms/lần, 1.79 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 27.4 s, 140 thao tác đã bắt đầu): WRITELOG 887 ms/140 lần (TB 6.34 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 285 ms/352 lần (TB 0.81 ms/lần, 2.51 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.1 s, 142 thao tác đã bắt đầu): WRITELOG 1558 ms/181 lần (TB 8.61 ms/lần, 1.27 lần/thao tác); PAGELATCH_EX 2 ms/4 lần (TB 0.50 ms/lần, 0.03 lần/thao tác); SOS_SCHEDULER_YIELD 1520 ms/299 lần (TB 5.08 ms/lần, 2.11 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.7 s, 285 thao tác đã bắt đầu): WRITELOG 2694 ms/444 lần (TB 6.07 ms/lần, 1.56 lần/thao tác); PAGELATCH_EX 4 ms/8 lần (TB 0.50 ms/lần, 0.03 lần/thao tác); PAGELATCH_SH 0 ms/6 lần (TB 0.00 ms/lần, 0.02 lần/thao tác); SOS_SCHEDULER_YIELD 996 ms/405 lần (TB 2.46 ms/lần, 1.42 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 356 thao tác đã bắt đầu): WRITELOG 1475 ms/385 lần (TB 3.83 ms/lần, 1.08 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 374 ms/290 lần (TB 1.29 ms/lần, 0.81 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 26.9 s, 366 thao tác đã bắt đầu): WRITELOG 1999 ms/397 lần (TB 5.04 ms/lần, 1.08 lần/thao tác); PAGELATCH_EX 5 ms/2 lần (TB 2.50 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 3 ms/2 lần (TB 1.50 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1190 ms/431 lần (TB 2.76 ms/lần, 1.18 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 40.9 s, 43 thao tác đã bắt đầu): WRITELOG 2246 ms/57 lần (TB 39.40 ms/lần, 1.33 lần/thao tác); PAGELATCH_SH 2 ms/1 lần (TB 2.00 ms/lần, 0.02 lần/thao tác); SOS_SCHEDULER_YIELD 18022 ms/598 lần (TB 30.14 ms/lần, 13.91 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 27.7 s, 238 thao tác đã bắt đầu): WRITELOG 1726 ms/254 lần (TB 6.80 ms/lần, 1.07 lần/thao tác); PAGELATCH_EX 6 ms/2 lần (TB 3.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 3 ms/1 lần (TB 3.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 2425 ms/652 lần (TB 3.72 ms/lần, 2.74 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 26.0 s, 422 thao tác đã bắt đầu): WRITELOG 1938 ms/454 lần (TB 4.27 ms/lần, 1.08 lần/thao tác); PAGELATCH_EX 96 ms/6 lần (TB 16.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 1 ms/2 lần (TB 0.50 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 5018 ms/633 lần (TB 7.93 ms/lần, 1.50 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 27.4 s, 784 thao tác đã bắt đầu): WRITELOG 3082 ms/885 lần (TB 3.48 ms/lần, 1.13 lần/thao tác); PAGELATCH_EX 256 ms/36 lần (TB 7.11 ms/lần, 0.05 lần/thao tác); PAGELATCH_SH 14 ms/3 lần (TB 4.67 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 724 ms/433 lần (TB 1.67 ms/lần, 0.55 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 28.6 s, 377 thao tác đã bắt đầu): WRITELOG 2244 ms/434 lần (TB 5.17 ms/lần, 1.15 lần/thao tác); PAGELATCH_EX 4 ms/5 lần (TB 0.80 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 875 ms/395 lần (TB 2.22 ms/lần, 1.05 lần/thao tác)
- khóa dòng tài khoản hệ thống perf1/system:ADJUSTMENT:USD = KEY: 5:72057594045857792 (18c56277a536)
- khóa dòng tài khoản hệ thống perf1/system:ADJUSTMENT:VND = KEY: 5:72057594045857792 (4334da4a7f50)
- khóa dòng tài khoản hệ thống perf1/system:GATEWAY:USD = KEY: 5:72057594045857792 (1264b333b001)
- khóa dòng tài khoản hệ thống perf1/system:GATEWAY:VND = KEY: 5:72057594045857792 (49950b0e6a67)
- khóa dòng tài khoản hệ thống perf1/system:MERCHANT:USD = KEY: 5:72057594045857792 (e3f62b1d6c1b)
- khóa dòng tài khoản hệ thống perf1/system:MERCHANT:VND = KEY: 5:72057594045857792 (b8079320b67d)
- ma trận: tổng thời gian chạy (gồm seed, chuẩn bị, đầu-cuối) 51.1 phút
