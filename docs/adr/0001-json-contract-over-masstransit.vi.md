# ADR-0001: Hợp đồng JSON thuần, không dùng envelope MassTransit

**Trạng thái:** Chấp nhận — 2026-10-09
**Cập nhật 2026-10-10:** hình dạng message (envelope) được thay bằng ADR-0008; quyết định "JSON thuần, không bám MassTransit" vẫn đúng.

## Bối cảnh

Ecommerce viết bằng C#/.NET với MassTransit; billing viết bằng Node.js. Hai bên giao tiếp bất đồng bộ qua RabbitMQ.

## Quyết định

Dùng JSON thuần do billing định nghĩa bằng JSON Schema (`packages/contracts`), version trong tên event và routing key
(`OrderPaidV1`, `order-paid.v1`; hình dạng phẳng theo ADR-0008), người nhận theo "tolerant reader". Không bám định dạng
envelope của MassTransit. (Bản gốc của quyết định này dùng envelope tự định nghĩa với `type` kiểu `billing.order-paid.v1`;
phần đó đã được ADR-0008 thay thế.)

## Hệ quả

- Phía .NET không bị ràng buộc vào thư viện; billing không phụ thuộc chi tiết nội bộ của MassTransit.
- Team ecommerce phải viết một adapter nhỏ nói JSON thuần cho 3 event ở spec mục 4.
- Schema được phát hành như một package/file có phiên bản, hai bên cùng kiểm thử bằng Pact.
