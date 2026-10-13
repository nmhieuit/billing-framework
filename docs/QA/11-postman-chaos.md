# Postman Chaos (nhóm L)

> **Giai đoạn 2, nhóm L.** Collection **`chaos.postman_collection.json`**: tải nền + "oracle" (kiểm bất biến) chạy qua HTTP trên local stack. Đi cùng [`10-manual-chaos.md`](10-manual-chaos.md) (rà soát code chaos và test thủ công).
> **Đã kiểm tra:** JSON hợp lệ, 30 script qua `node --check`, biến định nghĩa trước khi dùng, chạy Newman 6 trên **mock** (`postman/mock/server.cjs`). **Chưa chạy** với service thật.
> **Không thay thế** `pnpm test:chaos` (testcontainers, tiêm lỗi vào SQL/RabbitMQ/HTTP ở tầng code). `pnpm test:chaos` **cũng chưa chạy** trong phiên này (không có Docker).

## 1. Chaos Postman làm được và không làm được

| Có | Không |
| --- | --- |
| Sinh tải hợp lệ (topup, ops adjust/reverse) với `Idempotency-Key` cố định, **gửi lại cùng khóa** khi gặp lỗi tạm (5xx / mất phản hồi), đúng cách client thật xử lý | Tự tiêm lỗi vào SQL/RabbitMQ/payment: phần này do **bạn** làm bằng tay (docker stop/restart, `X-Simulate`, xem `10-manual-chaos.md`) trong lúc Workload chạy |
| Sau khi hệ thống ổn định, kiểm bất biến INV-1, 3, 5, 6, 7, 8 qua API (bản "lite") | Kiểm INV-2/4 đầy đủ, vì cần đọc DB/outbox trực tiếp (`assertSystemInvariants` trong `tests/chaos/support`) |
| Phát hiện lỗi đã tiêm vào mock: cộng tiền 2 lần, mất dòng sổ, adjust trùng, kẹt trạng thái (xem mục 6) | Chứng minh service thật đúng: mock do chính QA viết, chỉ chứng minh script và chuỗi request đúng |

Collection **không có folder EndPoints**: code chaos không thêm HTTP endpoint nào (API wallet/payment không đổi, xem `10-manual-chaos.md`).

## 2. Cách chạy

Import `postman/chaos/chaos.postman_collection.json` và `postman/billing-local.postman_environment.json`, chọn environment `billing-local`, đặt `webhook_secret` (secret) nếu muốn chạy CHR-04. **Chạy bằng Collection Runner/Newman, đúng thứ tự** (poll dùng `postman.setNextRequest`).

Quy trình đề xuất (trạng thái giữ trong biến environment `ch_*` giữa các lần chạy, vì vậy phải **dùng chung một environment**; với Newman dùng `--export-environment`):

1. `Smoke` ×1: hệ thống khỏe, có ví và topup nền.
2. `Workload` ×N (ví dụ 25-50 lượt): trong lúc chạy, tiêm lỗi thủ công (CHM-xxx).
3. Gỡ lỗi, chờ hệ thống hồi phục.
4. `Oracle` ×1: ORC-00 chờ ổn định tối đa `chaos_quiesce_seconds`, rồi ORC-01..06.
5. `Regression` bất kỳ lúc nào hệ thống khỏe.

```bash
npx newman run docs/QA/postman/chaos/chaos.postman_collection.json \
  -e docs/QA/postman/billing-local.postman_environment.json \
  --export-environment /tmp/chaos-state.json --folder Smoke \
  --env-var webhook_secret="$LOCAL_WEBHOOK_SECRET"
# các lần sau dùng -e /tmp/chaos-state.json, --folder Workload -n 25, rồi --folder Oracle
```

Trên mock: `node postman/mock/run-chaos.cjs <state.json> <Folder> [lượt]` (xem `postman/mock/README.md`).

## 3. Biến

| Biến | Mặc định | Ý nghĩa |
| --- | --- | --- |
| `chaos_quiesce_seconds` | `120` | Thời gian tối đa ORC-00 chờ mọi topup đã xác nhận rời trạng thái chờ. Tăng nếu lỗi gỡ chậm |
| `chaos_expect_missing_at_wallet` | `false` | `true` nếu bạn cố ý để tồn dư lệch (MISSING_AT_WALLET) trước đối soát |
| `chaos_allow_unknown_charge` | `true` | Cho phép charge không có topup (webhook rơi khi wallet chưa có bản ghi) trước đối soát; ORC-06 kiểm lại nghiêm ngặt sau đối soát |
| `webhook_secret` | trống (secret) | Chỉ cần cho CHR-04 |
| `ch_*` | do script tạo | Trạng thái chạy: `ch_custs`, `ch_topups`, `ch_ops`, `ch_adj_open`, `ch_pending_topup`, `ch_pending_op`, `ch_stats`, `ch_bad`, `ch_run`. **Không sửa tay**; xóa hết để bắt đầu lại |

## 4. Nội dung từng folder

| Folder | Request | Mục đích / bất biến |
| --- | --- | --- |
| Smoke | CHS-01..09 | Health, 4 ví (2 tenant), topup nền tới SUCCEEDED, oracle-lite trên hệ thống khỏe |
| Workload | WLD-01 | Topup, **gửi lại cùng khóa tới khi nhận 202**; chỉ topup đã xác nhận mới vào danh sách kiểm sau |
| | WLD-02 | Ops adjust/reverse, gửi lại cùng khóa tới khi xác nhận |
| | WLD-03, 04 | Đọc ví; tóm tắt (kiểm "có tải thật" chỉ ở lượt cuối) |
| Oracle | ORC-00 | Chờ ổn định (INV-8) |
| | ORC-01 | INV-8 hồi phục, INV-1 số dư = tổng dòng sổ, mỗi businessKey một dòng |
| | ORC-02 | INV-3 mỗi topup SUCCEEDED có đúng 1 dòng TOPUP và 1 charge SUCCEEDED khớp |
| | ORC-03 | INV-6 ops nguyên tử; gửi lại cùng khóa trả đúng kết quả cũ |
| | ORC-04 | INV-7 mọi topupId đã xác nhận vẫn đọc được |
| | ORC-05 | INV-5 chạy đối soát hai lần, kết quả hội tụ |
| | ORC-06 | Kiểm lại INV-1/3/8 nghiêm ngặt sau đối soát |
| Regression | CHR-01 | Gửi lại topup cùng khóa ×3: một topup, một lần cộng |
| | CHR-02, 03 | Gửi lại adjust / reverse cùng khóa ×3: một tác động |
| | CHR-04 | Webhook trùng / đến muộn không cộng hai lần (cần `webhook_secret`) |
| | CHR-05 | Đối soát hai lần trên hệ thống sạch hội tụ |

Gỡ lỗi khi Oracle đỏ: mỗi vi phạm có `code` + `detail` (ví dụ `DUPLICATE_BUSINESS_KEY`, `TOPUP_TX_MISSING`, `IDEMPOTENT_REPLAY_MISMATCH`). Một lần đỏ **không tự là bug**: kiểm tra trước xem lỗi đã được gỡ và hệ thống đã ổn định chưa (tăng `chaos_quiesce_seconds`).

## 5. Kết quả kiểm trên mock (hệ thống sạch)

| Folder | Request | Assertion | Lỗi |
| --- | --- | --- | --- |
| Smoke ×1 | 23 | 20 | 0 |
| Workload ×12 | 48 | 61 | 0 |
| Oracle ×1 | 154 | 14 | 0 |
| Regression ×1 | 45 | 21 | 0 |

Bốn collection cũ (wallet, payment, ops, reconciliations) chạy lại trên mock đã sửa: vẫn 0 lỗi.

## 6. Oracle có bắt được lỗi không (tiêm lỗi vào mock)

| `MOCK_BUG` | Hành vi tiêm | Kết quả |
| --- | --- | --- |
| `double_credit` | cộng tiền hai lần cho một topup | Smoke CHS-09 và Oracle ORC-01/02/06 đỏ (`DUPLICATE_BUSINESS_KEY`, `TOPUP_TX_MISSING`) |
| `lost_entry` | mất dòng sổ khi cộng tiền | Smoke CHS-09, Oracle ORC-01/02 đỏ (`BALANCE_DRIFT`, `TOPUP_TX_MISSING`) |
| `dup_adjust` | ops adjust cùng khóa tạo tác động thứ hai | Chỉ Oracle ORC-03 đỏ (`IDEMPOTENT_REPLAY_MISMATCH`); Smoke xanh vì không replay |
| `stuck` | topup kẹt PENDING | Smoke CHS-08/09 và Oracle ORC-00 (hết `chaos_quiesce_seconds`), ORC-02 đỏ (`TOPUP_NOT_SETTLED`) |

`MOCK_FLAKY=0.3` (30% request lỗi 503 hoặc mất phản hồi): **Workload và Oracle chịu được nhờ gửi lại cùng khóa**; riêng **Smoke không chịu lỗi tạm** (CHS-07 không retry vì Smoke chỉ dành cho hệ thống khỏe), nên chạy Smoke khi chưa tiêm lỗi.

## 7. Giới hạn

- Mock viết từ cùng hiểu biết với collection nên không phát hiện hiểu sai về service thật.
- Oracle chỉ nhìn qua API; không thấy outbox/DB.
- Thời gian ổn định thực tế phụ thuộc interval của worker; nay chỉnh được bằng `PAYMENT_WORKER_INTERVAL_MS` / `WALLET_WORKER_INTERVAL_MS` trong `deploy/.env` (xem `10-manual-chaos.md` mục 6). Với `20000` ms, tăng `chaos_quiesce_seconds` tương ứng.
