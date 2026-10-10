# ADR-0008: Event JSON phẳng theo quy ước của ecommerce, bỏ envelope chung

**Trạng thái:** Chấp nhận — 2026-10-10. Thay thế phần "envelope" của ADR-0001 (phần "JSON thuần, không bám MassTransit" vẫn giữ).

## Bối cảnh

Spec nền tảng định nghĩa một envelope chung (`messageId`, `type`, `occurredAt`, `causationId`, `data`). Khi làm Bước 4,
ecommerce đã có event thật (`OrderPlacedV1`) theo quy ước khác: JSON phẳng, `eventId`/`occurredAtUtc`/`tenantId`/
`correlationId` cùng các trường nghiệp vụ, version trong tên, schema bất biến sau khi phát hành (`shared/EventContracts`).

## Quyết định

Mọi event của luồng order dùng JSON phẳng như quy ước của ecommerce, cho cả `orders.events` lẫn `billing.events`:
`OrderReadyForPaymentV1`, `OrderPaidV1`, `OrderPaymentFailedV1`. Version nằm trong tên event và routing key
(`order-paid.v1`). `amount` là số nguyên minor unit kèm `currency` (khác `total decimal` của ecommerce; adapter bên đó đổi).
Người nhận theo "tolerant reader". Schema nằm ở `packages/contracts` và được emit thành `{Event}.v{N}.schema.json`.

## Phương án đã loại

Giữ envelope của billing: có `causationId` và `type` tường minh, nhưng buộc ecommerce thêm một lớp bọc khác với các event họ đang phát.

## Hệ quả

Hai bên dùng cùng một kiểu event; không có `causationId` (chuỗi nguyên nhân dựa vào `correlationId` và `eventId`).
`validateMessage`/`Envelope` bị xóa khỏi `@billing/contracts`; thay bằng `validateEvent(name, raw)`.
