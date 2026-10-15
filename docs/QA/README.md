# Tài liệu QA: billing-framework

Dành cho tester và người mới onboard. Mọi test chạy trên **local stack**.

## Đọc theo thứ tự này

1. [`gioi-thieu-he-thong.md`](gioi-thieu-he-thong.md): hệ thống làm gì (ví, nạp tiền, thanh toán order, đối soát, vận hành, retention) và danh sách endpoint.
2. [`moi-truong-va-du-lieu.md`](moi-truong-va-du-lieu.md): dựng stack, tenant, header, dữ liệu test, biến cần có trước khi chạy.
3. [`huong-dan-postman.md`](huong-dan-postman.md): dùng collection `Billing` và environment `billing-local`.
4. Test case theo nghiệp vụ, đọc theo thứ tự ưu tiên rủi ro:

| Thứ tự | Nghiệp vụ | Tài liệu |
| --- | --- | --- |
| 1 | Ví, nạp tiền, sổ cái, tenant, webhook | [`test-case/wallet.md`](test-case/wallet.md) |
| 2 | Cổng thanh toán giả lập (payment) | [`test-case/payment-simulator.md`](test-case/payment-simulator.md) |
| 3 | Thanh toán order qua RabbitMQ | [`test-case/order-payment.md`](test-case/order-payment.md) |
| 4 | Công cụ vận hành (ops) | [`test-case/ops.md`](test-case/ops.md) |
| 5 | Đối soát | [`test-case/doi-soat.md`](test-case/doi-soat.md) |
| 6 | Retention và quan sát | [`test-case/retention-quan-sat.md`](test-case/retention-quan-sat.md) |
| 7 | Chaos (lỗi hạ tầng giữa tải) | [`test-case/chaos.md`](test-case/chaos.md) |

## E2E liên service

Các luồng e2e xuyên nhiều service (nạp tiền, thanh toán order, vận hành, đối soát, gián đoạn, retention): [`e2e/overview.md`](e2e/overview.md).

## Test tự động của dev: đã phủ gì, QA cần làm tay gì

- [`auto_test/loai-test.md`](auto_test/loai-test.md): các loại test có trong source, nằm ở đâu, chạy thế nào.
- [`auto_test/coverage.md`](auto_test/coverage.md): coverage hiện tại và cách đọc con số.
- [`auto_test/ma-tran-phu.md`](auto_test/ma-tran-phu.md): hành vi nghiệp vụ nào đã có test tự động.
- [`auto_test/tranh-manual-lap.md`](auto_test/tranh-manual-lap.md): quy tắc để không test manual lại những gì đã được tự động kiểm.

## Quy ước trong các bảng test case

- **ID**: mã case (ví dụ `WLT-001`). **Loại**: `S` = Smoke (chạy mỗi lần deploy), `R` = Regression.
- **Ưu tiên**: `P1` cao nhất (tiền, đúng/sai), `P2` quan trọng, `P3` phụ.
- Cuối mỗi tài liệu có "Bộ Smoke đề xuất".

## Tệp Postman

- [`postman/billing.postman_collection.json`](postman/billing.postman_collection.json)
- [`postman/billing-local.postman_environment.json`](postman/billing-local.postman_environment.json)
