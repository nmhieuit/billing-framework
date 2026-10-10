# Runbook: đối soát wallet

Thiết kế: [spec](../superpowers/specs/2026-10-10-reconciliation-design.md); quyết định:
[ADR-0010](../adr/0010-reconciliation-read-only-immutable-runs.vi.md).

## Đối soát chạy thế nào

- Mỗi tenant được đối soát **ngày D-1 (UTC)** một lần mỗi ngày, bởi task `reconcile-daily` trong worker, sau
  `RECONCILE_AT_UTC_HOUR` (mặc định 02:00 UTC).
- Mỗi lượt kiểm tra ledger nội bộ, rồi so sao kê của payment (ngày D) với bảng `topups`; `MISSING_AT_GATEWAY` tra cả ngày D-1.
- Lượt là **bất biến**: chạy lại tạo lượt mới, không sửa lượt cũ. Chỉ ca (item) được đóng bằng ghi chú.
- Mặc định đối soát chỉ đọc. Ngoại lệ duy nhất: `MISSING_AT_WALLET` được tự ghi bù (nếu `RECONCILE_AUTOFIX=true`) qua đường
  nạp bình thường, với event id `reconcile:<runId>:<chargeId>`; business key `topup:<id>` bảo đảm không cộng hai lần.

## Chạy tay

Mọi lời gọi cần `x-tenant-id`; ở môi trường thật chỉ gọi qua gateway (endpoint là nội bộ).

```bash
H='-H x-tenant-id:acme -H content-type:application/json'

# Chạy đối soát cho một ngày UTC (không ở tương lai) -> 202 {"runId":"...","status":"RUNNING"}
curl -s -X POST localhost:3001/reconciliations $H -d '{"date":"2026-10-09"}'

# Xem trạng thái và tổng kiểm của lượt
curl -s localhost:3001/reconciliations/<runId> $H

# Liệt kê các ca còn mở (phân trang: limit 1..500, mặc định 100; dùng nextCursor làm cursor)
curl -s "localhost:3001/reconciliations/<runId>/items?caseStatus=OPEN" $H

# Đóng ca: status RESOLVED hoặc IGNORED, note 1..500 ký tự, resolvedBy 1..64 ký tự
curl -s -X POST localhost:3001/reconciliation-items/<itemId>/resolve $H \
  -d '{"status":"RESOLVED","note":"đã điều chỉnh ngoài hệ thống, ticket 123","resolvedBy":"an.nguyen"}'
```

Lỗi thường gặp: `422 INVALID_RECONCILIATION` (ngày sai/tương lai, thiếu `note`/`resolvedBy`, `status` sai),
`404 RECONCILIATION_NOT_FOUND` / `RECONCILIATION_ITEM_NOT_FOUND`, `409 RECONCILIATION_CONFLICT` (ca đã đóng với giá trị khác;
đóng lại cùng giá trị thì trả cùng kết quả), `400 INVALID_QUERY` (limit, cursor hoặc caseStatus sai).

## Loại lệch: ý nghĩa và việc cần làm

| Loại lệch | Ý nghĩa | Việc cần làm |
|---|---|---|
| `MISSING_AT_WALLET`, action `AUTO_APPLIED` | Payment đã thu tiền mà webhook bị mất; wallet đã tự ghi bù (hoặc topup đã `SUCCEEDED` do webhook đến trước) | Không cần làm |
| `MISSING_AT_WALLET`, action `FAILED_AUTOFIX` | Tự ghi bù không thành | Xem `detail.autofix` (kết quả như `DUPLICATE`, `MISMATCH`, `UNKNOWN_TOPUP` hoặc `error`), kiểm tra topup, xử lý rồi đóng ca |
| `MISSING_AT_WALLET`, action `NONE` | `RECONCILE_AUTOFIX=false` | Bật cờ rồi chạy lại, hoặc xử lý tay và đóng ca |
| `UNKNOWN_CHARGE` | Payment có charge mà wallet không có topup (hoặc topup gắn charge khác): tiền đã thu nhưng không thuộc lần nạp nào | Điều tra với team payment; **không tự ghi sổ** |
| `MISSING_AT_GATEWAY` | Wallet đã cộng tiền mà payment không có charge | Nghi ghi sổ sai; đóng băng ví nếu cần (chưa có tính năng) và điều tra |
| `AMOUNT_MISMATCH`, `STATUS_MISMATCH` | Khác số tiền/đồng tiền hoặc khác trạng thái | Đối chiếu `detail`, quyết định bút toán điều chỉnh (chưa có API, làm ngoài hệ thống), rồi đóng ca `RESOLVED`; sai lệch chấp nhận được thì `IGNORED` kèm lý do |
| `LEDGER_UNBALANCED`, `BALANCE_MISMATCH` | Lỗi toàn vẹn dữ liệu (giao dịch không cân, hoặc số dư cache khác tổng sổ cái): **mức cao nhất** | Dừng thay đổi ví của tenant, báo kỹ thuật ngay; log `ledger integrity check failed` |

## Đọc trạng thái lượt

- `COMPLETED`: đã xong, xem `itemCount` và các ca `OPEN`.
- `RUNNING`: đang chạy. Lượt `RUNNING` quá 30 phút bị coi là worker đã chết và chuyển `FAILED` ở tick lịch kế tiếp.
- `FAILED` + `failureReason`: payment lỗi/timeout, vượt `RECONCILE_MAX_ITEMS`, hoặc lỗi bất ngờ. Không có item nào được lưu.
  **Lưu ý:** nếu lượt thất bại sau khi đã tự ghi bù, `failureReason` nêu các topup đã được ghi bù trước đó
  (dạng `N topups already auto-credited: ...`); tiền của chúng đã vào ví và đúng, không cần hoàn tác. Lượt sau sẽ thấy chúng là khớp.
- Lượt định kỳ `FAILED` được thử lại tối đa `RECONCILE_MAX_ATTEMPTS` lần, cách nhau ít nhất 15 phút. Hết lượt thử, log
  `scheduled reconciliation gave up` (`error`): sửa nguyên nhân rồi chạy tay bằng `POST /reconciliations`. Trạng thái
  `GAVE_UP` được nhớ trong bộ nhớ worker tới hết ngày hoặc tới khi khởi động lại.

## Cấu hình

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `RECONCILE_AUTOFIX` | `true` | Tự ghi bù `MISSING_AT_WALLET` |
| `RECONCILE_AT_UTC_HOUR` | `2` | Giờ UTC sớm nhất chạy lượt định kỳ cho ngày hôm qua |
| `RECONCILE_MAX_ATTEMPTS` | `3` | Số lượt định kỳ tối đa mỗi (tenant, ngày) trước khi bỏ cuộc |
| `RECONCILE_MAX_ITEMS` | `50000` | Giới hạn số charge/lệch; vượt thì lượt `FAILED` |

Cần thêm `PAYMENT_BASE_URL` và credential payment hiện có để đọc sao kê.

## Giới hạn hiện tại

- Chưa có metric/cảnh báo (Bước 6): theo dõi bằng log và bảng `reconciliation_runs`.
- Charge không có `metadata.tenantId` (hoặc của tenant khác) bị bỏ qua, không báo ở tenant nào.
- Tổng kiểm (`gatewayTotals`/`walletTotals`) chỉ để tham khảo vì lệch biên ngày; chỉ so từng item mới sinh lệch.
- Phép Wallet ↔ Orders chưa chạy: xem [orders-reconciliation](orders-reconciliation.vi.md).
