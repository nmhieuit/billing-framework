# ADR-0004: Dùng chung nền tảng, cô lập dữ liệu và broker

**Trạng thái:** Chấp nhận — 2026-10-09

## Quyết định

Dùng chung cụm K8s, CI (Jenkins + SonarQube), observability, Vault và hạ tầng SQL Server/RabbitMQ của ecommerce.
Cô lập ở mức dữ liệu: DB riêng, user SQL riêng, vhost RabbitMQ `billing` và user riêng cho từng service.

## Hệ quả

Tiết kiệm vận hành; lỗi billing không chạm dữ liệu order. Đổi lại, phụ thuộc vào độ sẵn sàng của hạ tầng ecommerce
và cần thống nhất cách truy cập cổng từ máy phát triển (xem README).

## Điểm còn mở

Stack local của ecommerce chạy mỗi service một container SQL Server riêng, không có instance dùng chung; stack đầy
đủ thì có một `sqlserver`. Cần thống nhất với team ecommerce instance nào chứa DB của billing trước khi làm Wallet core.
