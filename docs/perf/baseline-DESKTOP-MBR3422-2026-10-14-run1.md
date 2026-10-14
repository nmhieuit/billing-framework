# Báo cáo hiệu năng

- Thời điểm: 2026-10-14T02:13:50.130Z
- Máy: DESKTOP-MBR3422 (4 CPU, 31.9 GB RAM, Node v22.20.0, Windows_NT 10.0.22000 x64)
- SQL Server: Microsoft SQL Server 2022 (RTM-CU26) (KB5093420) - 16.0.4265.3 (X64)
- Git: ac664387dc357324755330b0988308d405399116
- Hợp lệ: có

## Kịch bản: pay-order

Mỗi thao tác trả một order 1 000 VND cho một khách ngẫu nhiên: mọi lệnh cùng khóa tài khoản MERCHANT (điểm nóng).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 31.3 | 30.6–35.6 | 56.6 | 79.0 | 0 |
| 4 | 42.7 | 31.0–44.3 | 167.6 | 249.7 | 0 |
| 16 | 19.9 | 17.4–21.6 | 1581.8 | 1968.1 | 0 |
| 64 | 17.2 | 16.3–42.0 | 5827.1 | 6106.8 | 0 |

## Kịch bản: topup-apply

Mỗi thao tác áp kết quả charge.succeeded cho một topup PENDING chưa dùng (hàng đợi seed trước, ngoài cửa sổ đo).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 30.8 | 29.2–33.3 | 56.4 | 98.7 | 0 |
| 4 | 40.9 | 23.9–41.2 | 146.9 | 209.1 | 0 |
| 16 | 19.3 | 8.2–25.8 | 3025.6 | 3918.3 | 0 |
| 64 | 54.5 | 42.8–57.1 | 1620.6 | 1676.1 | 0 |

## Kịch bản: mixed

Hỗn hợp: 70% trả order, 15% áp nạp tiền, 10% điều chỉnh CREDIT ví, 5% đảo một giao dịch ORDER_PAYMENT đã tạo trong lượt (chưa có thì trả order thay).

| Mức đồng thời | Thông lượng/giây (trung vị) | min–max | p95 (ms) | p99 (ms) | Lỗi |
| --- | --- | --- | --- | --- | --- |
| 1 | 37.1 | 36.5–38.7 | 45.0 | 65.8 | 0 |
| 4 | 48.1 | 47.7–60.9 | 132.9 | 177.9 | 0 |
| 16 | 49.4 | 47.5–49.4 | 618.4 | 767.7 | 0 |
| 64 | 40.4 | 38.5–46.3 | 3461.5 | 4818.4 | 0 |

## Chờ khóa nổi bật

### pay-order

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 45491 | KEY: 5:72057594045857792 (b8079320b67d) (45491) |
| LCK_M_S | select * from "t_perf1"."accounts" where "id" = @1 | 2 | KEY: 5:72057594045857792 (4967d3d1c561) (2) |

### topup-apply

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 47586 | KEY: 5:72057594045857792 (49950b0e6a67) (47586) |

### mixed

| Loại chờ | Câu lệnh | Số lần | Tài nguyên chờ nhiều nhất |
| --- | --- | --- | --- |
| LCK_M_U | select id, kind, customer_id, currency, balance, created_at, frozen_at, frozen_by, frozen_reason from "t_perf1"."account | 46279 | KEY: 5:72057594045857792 (b8079320b67d) (46058); KEY: 5:72057594045857792 (49950b0e6a67) (175); KEY: 5:72057594045857792 (4334da4a7f50) (46) |
| LCK_M_S | select "e"."account_id", "e"."amount", "a"."currency" from "t_perf1"."ledger_entries" as "e" inner join "t_perf1"."accou | 2786 | KEY: 5:72057594045857792 (b8079320b67d) (2786) |
| LCK_M_S | select * from "t_perf1"."accounts" where "id" = @1 | 1 | KEY: 5:72057594045857792 (4bec9ff9538c) (1) |

## End-to-end

- Số đơn: 200
- Mức đồng thời: 16
- Thông lượng/giây: 14.0
- p50 / p95 / p99 (ms): 1095.1 / 1431.2 / 1486.5
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
- kịch bản pay-order, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 684 thao tác đã bắt đầu): WRITELOG 832 ms/711 lần (TB 1.17 ms/lần, 1.04 lần/thao tác); SOS_SCHEDULER_YIELD 3 ms/43 lần (TB 0.07 ms/lần, 0.06 lần/thao tác)
- kịch bản pay-order, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 788 thao tác đã bắt đầu): WRITELOG 658 ms/795 lần (TB 0.83 ms/lần, 1.01 lần/thao tác); SOS_SCHEDULER_YIELD 20 ms/44 lần (TB 0.45 ms/lần, 0.06 lần/thao tác)
- kịch bản pay-order, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 732 thao tác đã bắt đầu): WRITELOG 671 ms/734 lần (TB 0.91 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 2 ms/43 lần (TB 0.05 ms/lần, 0.06 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 1031 thao tác đã bắt đầu): WRITELOG 882 ms/1033 lần (TB 0.85 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 2 ms/1 lần (TB 2.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 47 ms/99 lần (TB 0.47 ms/lần, 0.10 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 968 thao tác đã bắt đầu): WRITELOG 910 ms/975 lần (TB 0.93 ms/lần, 1.01 lần/thao tác); PAGELATCH_SH 1 ms/2 lần (TB 0.50 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 41 ms/81 lần (TB 0.51 ms/lần, 0.08 lần/thao tác)
- kịch bản pay-order, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.4 s, 765 thao tác đã bắt đầu): WRITELOG 966 ms/772 lần (TB 1.25 ms/lần, 1.01 lần/thao tác); PAGELATCH_SH 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 79 ms/131 lần (TB 0.60 ms/lần, 0.17 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.8 s, 496 thao tác đã bắt đầu): WRITELOG 1135 ms/519 lần (TB 2.19 ms/lần, 1.05 lần/thao tác); PAGEIOLATCH_EX 10 ms/1 lần (TB 10.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 232 ms/221 lần (TB 1.05 ms/lần, 0.45 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 400 thao tác đã bắt đầu): WRITELOG 1135 ms/420 lần (TB 2.70 ms/lần, 1.05 lần/thao tác); PAGELATCH_EX 1 ms/5 lần (TB 0.20 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 276 ms/187 lần (TB 1.48 ms/lần, 0.47 lần/thao tác)
- kịch bản pay-order, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.6 s, 465 thao tác đã bắt đầu): WRITELOG 1150 ms/482 lần (TB 2.39 ms/lần, 1.04 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 152 ms/198 lần (TB 0.77 ms/lần, 0.43 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 29.3 s, 408 thao tác đã bắt đầu): WRITELOG 1496 ms/432 lần (TB 3.46 ms/lần, 1.06 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1938 ms/361 lần (TB 5.37 ms/lần, 0.88 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 25.1 s, 420 thao tác đã bắt đầu): WRITELOG 1209 ms/449 lần (TB 2.69 ms/lần, 1.07 lần/thao tác); PAGELATCH_EX 4 ms/7 lần (TB 0.57 ms/lần, 0.02 lần/thao tác); PAGELATCH_SH 0 ms/7 lần (TB 0.00 ms/lần, 0.02 lần/thao tác); PAGEIOLATCH_SH 13 ms/2 lần (TB 6.50 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 725 ms/296 lần (TB 2.45 ms/lần, 0.70 lần/thao tác)
- kịch bản pay-order, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.5 s, 999 thao tác đã bắt đầu): WRITELOG 986 ms/1004 lần (TB 0.98 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 294 ms/178 lần (TB 1.65 ms/lần, 0.18 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 28.6 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 1: 1824 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 25.0 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 2: 1909 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 21.9 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản topup-apply, mức 1, lần lặp 3: 1887 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 32.0 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 1: 2509 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 33.4 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 2: 2512 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 4, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 43.3 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản topup-apply, mức 4, lần lặp 3: 2879 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 202.4 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 1: 3259 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 270.9 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 2: 3007 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 16, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 83.9 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản topup-apply, mức 16, lần lặp 3: 2944 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 57.4 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 1: 2627 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 28.5 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 2: 2252 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 64, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 31.8 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản topup-apply, mức 64, lần lặp 3: 2239 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản topup-apply, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 766 thao tác đã bắt đầu): WRITELOG 778 ms/780 lần (TB 1.00 ms/lần, 1.02 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGEIOLATCH_SH 2 ms/2 lần (TB 1.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 42 ms/129 lần (TB 0.33 ms/lần, 0.17 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 681 thao tác đã bắt đầu): WRITELOG 702 ms/688 lần (TB 1.02 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 1 ms/3 lần (TB 0.33 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 33 ms/59 lần (TB 0.56 ms/lần, 0.09 lần/thao tác)
- kịch bản topup-apply, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 703 thao tác đã bắt đầu): WRITELOG 678 ms/716 lần (TB 0.95 ms/lần, 1.02 lần/thao tác); PAGELATCH_EX 4 ms/3 lần (TB 1.33 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 17 ms/115 lần (TB 0.15 ms/lần, 0.16 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 949 thao tác đã bắt đầu): WRITELOG 846 ms/954 lần (TB 0.89 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 102 ms/175 lần (TB 0.58 ms/lần, 0.18 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 946 thao tác đã bắt đầu): WRITELOG 846 ms/946 lần (TB 0.89 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGEIOLATCH_SH 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 50 ms/117 lần (TB 0.43 ms/lần, 0.12 lần/thao tác)
- kịch bản topup-apply, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.9 s, 579 thao tác đã bắt đầu): WRITELOG 1021 ms/582 lần (TB 1.75 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 480 ms/479 lần (TB 1.00 ms/lần, 0.83 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.9 s, 223 thao tác đã bắt đầu): WRITELOG 1196 ms/232 lần (TB 5.16 ms/lần, 1.04 lần/thao tác); PAGELATCH_EX 12 ms/6 lần (TB 2.00 ms/lần, 0.03 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1675 ms/703 lần (TB 2.38 ms/lần, 3.15 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.5 s, 475 thao tác đã bắt đầu): WRITELOG 1092 ms/480 lần (TB 2.27 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 638 ms/313 lần (TB 2.04 ms/lần, 0.66 lần/thao tác)
- kịch bản topup-apply, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.9 s, 538 thao tác đã bắt đầu): WRITELOG 1023 ms/546 lần (TB 1.87 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/4 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 1117 ms/262 lần (TB 4.26 ms/lần, 0.49 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.1 s, 951 thao tác đã bắt đầu): WRITELOG 1036 ms/958 lần (TB 1.08 ms/lần, 1.01 lần/thao tác); PAGELATCH_EX 62 ms/4 lần (TB 15.50 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 88 ms/5 lần (TB 17.60 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 487 ms/215 lần (TB 2.27 ms/lần, 0.23 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.1 s, 1326 thao tác đã bắt đầu): WRITELOG 1080 ms/1455 lần (TB 0.74 ms/lần, 1.10 lần/thao tác); PAGELATCH_EX 0 ms/1 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 58 ms/104 lần (TB 0.56 ms/lần, 0.08 lần/thao tác)
- kịch bản topup-apply, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.2 s, 1339 thao tác đã bắt đầu): WRITELOG 960 ms/1340 lần (TB 0.72 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 0 ms/2 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 73 ms/124 lần (TB 0.59 ms/lần, 0.09 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 4.6 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 578 (68.3%, trong đó 0 trả thay cho đảo), nạp 151 (17.8%), điều chỉnh 83 (9.8%), đảo 34 (4.0%); 317 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 3.2 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 585 (68.8%, trong đó 0 trả thay cho đảo), nạp 131 (15.4%), điều chỉnh 94 (11.1%), đảo 40 (4.7%); 337 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 3.7 s, cỡ hàng đợi tối đa 2590 thao tác
- kịch bản mixed, mức 1, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 645 (72.4%, trong đó 0 trả thay cho đảo), nạp 129 (14.5%), điều chỉnh 75 (8.4%), đảo 42 (4.7%); 339 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 4.7 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 984 (69.8%, trong đó 0 trả thay cho đảo), nạp 201 (14.3%), điều chỉnh 144 (10.2%), đảo 80 (5.7%); 426 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 5.4 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 787 (70.3%, trong đó 1 trả thay cho đảo), nạp 171 (15.3%), điều chỉnh 105 (9.4%), đảo 57 (5.1%); 456 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 4, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 4.6 s, cỡ hàng đợi tối đa 3458 thao tác
- kịch bản mixed, mức 4, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 783 (70.6%, trong đó 1 trả thay cho đảo), nạp 170 (15.3%), điều chỉnh 95 (8.6%), đảo 61 (5.5%); 457 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 5.0 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 816 (71.1%, trong đó 1 trả thay cho đảo), nạp 177 (15.4%), điều chỉnh 109 (9.5%), đảo 45 (3.9%); 466 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 4.9 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 765 (68.6%, trong đó 1 trả thay cho đảo), nạp 166 (14.9%), điều chỉnh 107 (9.6%), đảo 77 (6.9%); 477 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 16, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 4.9 s, cỡ hàng đợi tối đa 3482 thao tác
- kịch bản mixed, mức 16, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 812 (70.9%, trong đó 0 trả thay cho đảo), nạp 164 (14.3%), điều chỉnh 119 (10.4%), đảo 51 (4.5%); 479 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 1: chuẩn bị (seed, NGOÀI cửa sổ đo) 5.2 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 1: thao tác thực tế (cả khởi động và xả): trả order 773 (70.0%, trong đó 2 trả thay cho đảo), nạp 183 (16.6%), điều chỉnh 87 (7.9%), đảo 61 (5.5%); 526 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 2: chuẩn bị (seed, NGOÀI cửa sổ đo) 5.8 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 2: thao tác thực tế (cả khởi động và xả): trả order 691 (67.9%, trong đó 3 trả thay cho đảo), nạp 191 (18.8%), điều chỉnh 99 (9.7%), đảo 36 (3.5%); 518 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 64, lần lặp 3: chuẩn bị (seed, NGOÀI cửa sổ đo) 6.6 s, cỡ hàng đợi tối đa 3578 thao tác
- kịch bản mixed, mức 64, lần lặp 3: thao tác thực tế (cả khởi động và xả): trả order 696 (71.8%, trong đó 6 trả thay cho đảo), nạp 137 (14.1%), điều chỉnh 93 (9.6%), đảo 43 (4.4%); 572 topup PENDING chưa dùng còn lại trong DB (tích lũy qua các lần lặp, vô hại)
- kịch bản mixed, mức 1, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 846 thao tác đã bắt đầu): WRITELOG 692 ms/866 lần (TB 0.80 ms/lần, 1.02 lần/thao tác); SOS_SCHEDULER_YIELD 5 ms/44 lần (TB 0.11 ms/lần, 0.05 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.1 s, 850 thao tác đã bắt đầu): WRITELOG 660 ms/853 lần (TB 0.77 ms/lần, 1.00 lần/thao tác); PAGELATCH_EX 1 ms/6 lần (TB 0.17 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 0 ms/6 lần (TB 0.00 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 15 ms/53 lần (TB 0.28 ms/lần, 0.06 lần/thao tác)
- kịch bản mixed, mức 1, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 891 thao tác đã bắt đầu): WRITELOG 606 ms/891 lần (TB 0.68 ms/lần, 1.00 lần/thao tác); SOS_SCHEDULER_YIELD 1 ms/41 lần (TB 0.02 ms/lần, 0.05 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1409 thao tác đã bắt đầu): WRITELOG 2453 ms/1499 lần (TB 1.64 ms/lần, 1.06 lần/thao tác); PAGELATCH_EX 0 ms/6 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 1 ms/5 lần (TB 0.20 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 43 ms/92 lần (TB 0.47 ms/lần, 0.07 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1120 thao tác đã bắt đầu): WRITELOG 2852 ms/1267 lần (TB 2.25 ms/lần, 1.13 lần/thao tác); PAGELATCH_EX 7 ms/2 lần (TB 3.50 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 2 ms/1 lần (TB 2.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 24 ms/51 lần (TB 0.47 ms/lần, 0.05 lần/thao tác)
- kịch bản mixed, mức 4, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.2 s, 1109 thao tác đã bắt đầu): WRITELOG 3571 ms/1329 lần (TB 2.69 ms/lần, 1.20 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/2 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 21 ms/62 lần (TB 0.34 ms/lần, 0.06 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 1147 thao tác đã bắt đầu): WRITELOG 3494 ms/1357 lần (TB 2.57 ms/lần, 1.18 lần/thao tác); PAGELATCH_EX 1 ms/3 lần (TB 0.33 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 21 ms/66 lần (TB 0.32 ms/lần, 0.06 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 1115 thao tác đã bắt đầu): WRITELOG 2851 ms/1264 lần (TB 2.26 ms/lần, 1.13 lần/thao tác); PAGELATCH_EX 0 ms/4 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 44 ms/86 lần (TB 0.51 ms/lần, 0.08 lần/thao tác)
- kịch bản mixed, mức 16, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 23.5 s, 1146 thao tác đã bắt đầu): WRITELOG 2984 ms/1311 lần (TB 2.28 ms/lần, 1.14 lần/thao tác); PAGELATCH_EX 3 ms/7 lần (TB 0.43 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 6 ms/7 lần (TB 0.86 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 27 ms/71 lần (TB 0.38 ms/lần, 0.06 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 1: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.7 s, 1104 thao tác đã bắt đầu): WRITELOG 3689 ms/1315 lần (TB 2.81 ms/lần, 1.19 lần/thao tác); PAGELATCH_EX 2 ms/2 lần (TB 1.00 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 4 ms/7 lần (TB 0.57 ms/lần, 0.01 lần/thao tác); SOS_SCHEDULER_YIELD 157 ms/136 lần (TB 1.15 ms/lần, 0.12 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 2: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 24.7 s, 1017 thao tác đã bắt đầu): WRITELOG 2328 ms/1101 lần (TB 2.11 ms/lần, 1.08 lần/thao tác); PAGELATCH_EX 1 ms/4 lần (TB 0.25 ms/lần, 0.00 lần/thao tác); PAGELATCH_SH 0 ms/3 lần (TB 0.00 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 154 ms/157 lần (TB 0.98 ms/lần, 0.15 lần/thao tác)
- kịch bản mixed, mức 64, lần lặp 3: chờ ngoài khóa (khởi động + đo + xả + kiểm sổ cái, 25.3 s, 969 thao tác đã bắt đầu): WRITELOG 2909 ms/1225 lần (TB 2.37 ms/lần, 1.26 lần/thao tác); PAGELATCH_EX 3 ms/5 lần (TB 0.60 ms/lần, 0.01 lần/thao tác); PAGELATCH_SH 1 ms/3 lần (TB 0.33 ms/lần, 0.00 lần/thao tác); SOS_SCHEDULER_YIELD 292 ms/218 lần (TB 1.34 ms/lần, 0.22 lần/thao tác)
- khóa dòng tài khoản hệ thống perf1/system:ADJUSTMENT:USD = KEY: 5:72057594045857792 (18c56277a536)
- khóa dòng tài khoản hệ thống perf1/system:ADJUSTMENT:VND = KEY: 5:72057594045857792 (4334da4a7f50)
- khóa dòng tài khoản hệ thống perf1/system:GATEWAY:USD = KEY: 5:72057594045857792 (1264b333b001)
- khóa dòng tài khoản hệ thống perf1/system:GATEWAY:VND = KEY: 5:72057594045857792 (49950b0e6a67)
- khóa dòng tài khoản hệ thống perf1/system:MERCHANT:USD = KEY: 5:72057594045857792 (e3f62b1d6c1b)
- khóa dòng tài khoản hệ thống perf1/system:MERCHANT:VND = KEY: 5:72057594045857792 (b8079320b67d)
- ma trận: tổng thời gian chạy (gồm seed, chuẩn bị, đầu-cuối) 31.6 phút
