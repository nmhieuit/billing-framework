# ADR-0010: Đối soát chỉ đọc theo mặc định, lượt chạy bất biến, chỉ tự ghi bù qua đường nạp bình thường

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Wallet cần phát hiện sớm và có bằng chứng khi sổ cái không khớp với payment (gateway) hoặc với chính nó. Sửa sổ tiền tự động
mà sai còn nguy hiểm hơn lệch; trong các loại lệch, chỉ một loại chứng minh được là an toàn: payment đã xác nhận thu tiền
mà wallet chưa ghi (webhook mất).

## Quyết định

- **Chỉ đọc theo mặc định.** Đối soát chỉ ghi vào bảng của chính nó (`reconciliation_runs`, `reconciliation_items`).
- **Ngoại lệ duy nhất là `MISSING_AT_WALLET`**, được tự ghi bù qua `ApplyPaymentResult` (đường nạp bình thường) với event id
  theo lượt `reconcile:<runId>:<chargeId>`; business key `topup:<id>` chống ghi đôi dù webhook đến giữa chừng hoặc hai lượt
  chạy song song. Tắt được bằng `RECONCILE_AUTOFIX=false`.
- **Lượt bất biến:** chạy lại tạo lượt mới. Item chỉ đổi `case_status` và các cột `resolved_*` khi đóng ca.
- **Ca thủ công đóng bằng ghi chú** (`RESOLVED`/`IGNORED`, người xử lý, lý do), không sửa sổ; bút toán điều chỉnh làm ngoài.
- **Mỗi tenant một lượt định kỳ mỗi ngày** nhờ unique index lọc (`triggered_by = 'SCHEDULED' and status <> 'FAILED'`);
  lượt thất bại được thử lại có giới hạn.
- **Không giữ transaction qua lời gọi HTTP:** đọc topup, gọi sao kê của payment ngoài transaction, rồi ghi kết quả.

## Phương án đã loại

- Tự sửa sổ cái cho mọi loại lệch: một nhận định sai biến lệch thành mất tiền, và nhiều loại lệch cần quyết định nghiệp vụ.
- Một bảng đối soát dùng chung ngoài schema tenant: phá cô lập tenant (ADR-0006).
- Lập lịch bằng cron ngoài: chưa có hạ tầng, để Bước 6; hiện dùng worker sẵn có.

## Hệ quả

- Tổng kiểm chỉ để tham khảo (biên ngày: webhook sau nửa đêm); chỉ so từng item mới sinh lệch.
- Charge không có `metadata.tenantId` không thuộc tenant nào nên không được báo ở đâu.
- Sao kê quá lớn bị chặn bởi `RECONCILE_MAX_ITEMS`; lượt thất bại, không có item nào được lưu.
- Lượt thất bại sau khi đã ghi bù: các topup đó vẫn được ghi (mỗi lần là một transaction riêng) và được nêu trong
  `failure_reason`.
- Trạng thái `DONE`/`GAVE_UP` của lịch nằm trong bộ nhớ worker; khởi động lại thì tra lại DB (an toàn nhờ unique index).
- Chưa có metric/cảnh báo (Bước 6); `reconciliation_runs` lưu đủ số liệu để đọc sau.
- Wallet ↔ Orders chờ ecommerce cung cấp snapshot: [hợp đồng](../integration/orders-reconciliation.vi.md).
- Mô hình tin cậy: endpoint đối soát chỉ cần header tenant và nhận `resolvedBy` do người gọi khai, nên chỉ được mở trong mạng vận hành, không đưa vào route hướng khách hàng.
- Vận hành: [runbook](../integration/reconciliation-runbook.vi.md).
