# ADR-0003: NestJS cho wallet, Fastify cho payment

**Trạng thái:** Chấp nhận — 2026-10-09

## Quyết định

Wallet có domain phức tạp (ledger, saga, đối soát) nên dùng NestJS để có DI, module và CQRS nhất quán.
Payment chỉ là bộ giả lập nhẹ nên dùng Fastify.

## Hệ quả

Hai bộ quy ước khác nhau. Giảm thiểu bằng: cùng kiến trúc bốn lớp, cùng package dùng chung, và lint ép ranh giới
giống nhau cho cả hai service. Wallet luôn dùng `@Inject(TOKEN)` tường minh.

Đã kiểm chứng: NestJS chạy được dạng ESM với `tsx` (khởi động và phục vụ `/health` thật), không cần CommonJS.
