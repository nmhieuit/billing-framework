# Tránh test manual lặp lại những gì test tự động đã kiểm

Tài liệu này giúp QA quyết định một case manual có đáng làm hay không, dựa trên [`ma-tran-phu.md`](ma-tran-phu.md). Các kết luận dưới đây là **đề xuất** rút từ việc đọc test; chúng chưa được dev xác nhận và không thay cho phán đoán của QA.

## 1. Test tự động chạy ở đâu (vì sao vẫn phải có manual)

Test tự động của dev chạy **trong process của test**, với SQL Server và RabbitMQ dựng riêng bằng container và đồng hồ giả (không chờ thật). Chúng kiểm **logic và dữ liệu**. Chúng **không** kiểm:

- Stack đã deploy (`billing-local` hoặc môi trường khác): cổng, `compose`, biến môi trường, gateway, mạng.
- Độ trễ và thời gian thật (backoff vài trăm giây, lease, qua đêm).
- Hạ tầng thật bị tác động bằng tay (`docker pause/stop/kill`, đóng kết nối RabbitMQ).
- Trạng thái thật trên Kibana (cảnh báo bật tắt, dashboard).
- Orders (ecommerce) thật: trong test là bản mô phỏng.

## 2. Quy tắc quyết định

Với mỗi case manual, đi lần lượt từ trên xuống:

| Bước | Câu hỏi | Nếu có | Nếu không |
| --- | --- | --- | --- |
| 1 | Hành vi này có trong [`ma-tran-phu.md`](ma-tran-phu.md) với nhãn **Đã phủ tự động** (loại I hoặc E, DB thật), và case chỉ kiểm logic hoặc mã lỗi? | Sang bước 2 | Làm manual (**Vẫn làm**) |
| 2 | Kết quả có phụ thuộc môi trường đã deploy, thời gian thật, hạ tầng thật hoặc Kibana? | Làm manual (**Vẫn làm**) | Sang bước 3 |
| 3 | Case có lấp được khoảng trống nêu ở cột "Khoảng trống" của hàng đó? | Làm manual (**Vẫn làm**) | **Bỏ qua**, ghi chú test tự động nào đã phủ |
| 4 | (Dùng cho Postman/Smoke) Cần xác nhận một lần trên stack thật rằng nghiệp vụ chạy được từ đầu đến cuối? | Giữ ở mức **Smoke** (chỉ happy path, không lặp cả bộ negative) | — |

Khi thấy test tự động "phủ" nhưng bạn nghi ngờ (tên test mơ hồ, tham số chưa đọc), đọc file test được nêu ở ma trận trước khi bỏ case.

## 3. Đối chiếu các case manual hiện có

Mã case lấy từ [`docs/QA/test-case/`](../QA/test-case/). Một số mã trùng giữa hai file (ví dụ `RES-001..004` có ở `order-payment.md` và `doi-soat.md`), nên cột đầu ghi rõ file.

### 3.1 Có thể bỏ qua (đã phủ tự động, không phụ thuộc môi trường)

| File | Case | Test tự động đã phủ (xem ma trận) |
| --- | --- | --- |
| `wallet.md` | WLT-001..013 (tạo ví, header, đồng tiền, 404) | `api.integration`, `create-wallet.integration`, `get-wallet.integration` |
| `wallet.md` | TOP-003..015 (tra cứu, số tiền, trần, 404, đồng tiền theo ví) | `api.integration`, `request-topup.integration` |
| `wallet.md` | IDM-001..006 (idempotency nạp tiền, kể cả đồng thời) | `api.integration`, `request-topup.integration`, `tests/e2e` |
| `wallet.md` | LED-001..007 (sổ cái, phân trang, query sai) | `api.integration`, `list-entries.integration`, `tests/e2e` |
| `wallet.md` | TEN-001..004 (cô lập tenant) | `request-topup.integration`, `tests/e2e`, `pay-order.integration` |
| `wallet.md` | WHK-001..011 (chữ ký, replay, schema, trùng, lệch tiền) | `api.integration`, `apply-payment-result.integration` |
| `payment-simulator.md` | PAY-003, PAY-030..033, SIM-001..012, STL-001..011 | `charges.route.test`, `create-charge.integration`, `scenario.test`, `get-settlement.integration`, `service.integration` |
| `order-payment.md` | ORD-001..016 | `pay-order.integration`, `order-payment.integration` |
| `order-payment.md` | DLQ-001..003 | `order-payment.integration`, `order-ready.decoder.test` |
| `ops.md` | OPS-001, 003, 005..006, 008..009; FRZ-001..013; ADJ-001..013; REV-001..012; RPL-001..006; LOG-001..008 | `ops.api.integration`, các test `application/*-wallet`, `reverse-transaction`, `replay-order-paid`, `ops.integration` |
| `doi-soat.md` | REC-001..006, REC-010..022, REC-030..036, RES-001..012, REC-040, REC-050 | `run-reconciliation.integration`, `reconciliations.api.integration`, `reconciliation-operations.integration` |
| `retention-quan-sat.md` | RET-010..013, RET-020..025 | `retention.test`, `retention.repository.integration`, `retention.integration` |

Ghi chú:
- Với `ops.md`, `OPS-002` (x-actor-id chỉ khoảng trắng) và `OPS-004` (header vai trò nhiều giá trị) chưa đọc được tham số test chi tiết: nên **vẫn làm** hoặc đọc `ops.api.integration` trước.
- Với `wallet.md` `WHK-*`, chữ ký ký tay là bước thủ công; test tự động đã phủ logic nên chỉ cần làm lại khi nghi ngờ cấu hình secret trên stack.

### 3.2 Giữ ở mức Smoke trên stack thật (xác nhận môi trường)

Các nhánh logic đã tự động phủ, nhưng QA vẫn cần **một lần chạy trên stack đã deploy** cho mỗi nghiệp vụ chính: tạo ví và nạp tiền, charge và sao kê, trả order qua RabbitMQ, ops cơ bản, đối soát. Dùng bộ Smoke của collection Postman (`Wallet/Smoke`, `Payment/Smoke`, `Ops/Smoke`, `Reconciliations/Smoke`) và các luồng e2e ở [`docs/QA/e2e`](../QA/e2e/overview.md). Chạy cả bộ `Regression` của Postman chỉ cần khi thay đổi cấu hình, gateway, secret hoặc môi trường, vì phần lớn nhánh lỗi của nó đã có test tự động tương đương.

### 3.3 Vẫn làm manual (khoảng trống, hoặc phụ thuộc môi trường)

| File | Case | Lý do |
| --- | --- | --- |
| `wallet.md` | LED-008 | Backoff thật (khoảng 756 giây), dừng `payment` bằng tay; test tự động dùng đồng hồ giả |
| `payment-simulator.md` | PAY-041, PAY-042, PAY-040, PAY-043..044 | Webhook thật giữa hai service đã deploy (wallet từ chối 400, wallet tạm dừng) |
| `payment-simulator.md` | SIM-003, SIM-005, SIM-006 | Thời gian thật (`delay`, `response=timeout` khoảng 30 giây) |
| `order-payment.md` | DLQ-004..007, RES-001..004 | Thao tác DLQ, dừng wallet và broker bằng tay, hạ tầng thật. Test tự động chỉ phủ phần liên quan: consumer chết sau commit trước khi ack, và outbox giữ kết quả khi chưa có nơi nhận (một phần RES-002, RES-003) |
| `order-payment.md` | OBS-001..004 | Metric, cảnh báo và dashboard Kibana thật |
| `order-payment.md` | ORD-S01 | Dữ liệu mẫu bằng lệnh `local:seed` trên stack thật |
| `ops.md` | OPS-002, OPS-004 | Chưa đọc được chi tiết tham số của test tự động (xem ghi chú trên) |
| `ops.md` | CON-001..004 | Một phần có test (freeze song song, đảo và replay song song); CON-004 (dừng wallet giữa chừng) là hạ tầng thật |
| `doi-soat.md` | REC-051, REC-052, REC-054 | Cảnh báo và dashboard Kibana thật |
| `doi-soat.md` | REC-053 | Lượt định kỳ qua đêm thật; test tự động dùng đồng hồ giả |
| `retention-quan-sat.md` | RET-001..006 | Cấu hình khi khởi động trên container thật (test tự động chỉ kiểm hàm đọc cấu hình) |
| `retention-quan-sat.md` | RET-030..035 | **Chưa thấy test tự động** cho hệ quả nghiệp vụ sau khi dọn (khử trùng, cửa sổ idempotency, sao kê) |
| `retention-quan-sat.md` | RET-040..044 | Metric, dashboard và cảnh báo thật |
| `chaos.md` | CHM-001..019 | Test tự động chaos kiểm chính xác đến từng câu lệnh bằng đồng hồ giả và không chạy trong CI; bản manual kiểm hành vi và độ trễ thật |

## 4. Checklist trước khi viết một case manual mới

1. Tìm hành vi trong [`ma-tran-phu.md`](ma-tran-phu.md). Nếu nhãn là **Đã phủ tự động**, đọc file test được nêu rồi mới quyết định.
2. Case của bạn kiểm **mã lỗi hoặc logic** (đã có test) hay kiểm **môi trường, thời gian, hạ tầng, hiển thị** (không có test)? Chỉ viết case cho vế sau.
3. Có thể gộp vào một luồng Smoke hoặc e2e có sẵn thay vì thêm case riêng không?
4. Case cần hạ tầng thật hoặc thời gian thật? Ghi rõ lệnh và thời gian chờ (xem [`docs/QA/e2e`](../QA/e2e/overview.md) làm mẫu).
5. Nếu phát hiện test tự động còn thiếu (nhãn **Chưa thấy test tự động**), ghi lại cho dev thay vì chỉ dựa vào manual lâu dài.
