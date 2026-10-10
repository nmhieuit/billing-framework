# ADR-0006: Mỗi tenant một schema trong database của wallet

**Trạng thái:** Chấp nhận — 2026-10-10

## Bối cảnh

Wallet phục vụ nhiều tenant của gateway ecommerce. Cùng một `customerId` ở hai tenant là hai người khác nhau, và
một lỗi lộ dữ liệu chéo tenant trong dịch vụ giữ tiền là không chấp nhận được.

## Quyết định

Mỗi tenant có schema riêng `t_<tenant>` trong database `billing_wallet`, chứa đủ bảng của wallet (tài khoản,
ledger, lần nạp, idempotency, inbox). Tenant lấy từ header `X-Tenant-Id` (API) hoặc từ `data.metadata.tenantId` của
webhook **sau khi** xác thực chữ ký, và phải nằm trong `WALLET_TENANTS`. Mọi truy cập DB đi qua
`TenantUnitOfWork.run(tenant, …)`: không có cách lấy repository mà không đưa `TenantId`; Kysely dùng `withSchema`, SQL
thô luôn dùng `sql.id(schema, tên)`. Migration chạy theo từng schema với bảng theo dõi nằm trong chính schema đó
(`migrationTableSchema`); khi khởi động wallet từ chối chạy nếu còn tenant chưa migrate. Thêm tenant = thêm vào
`WALLET_TENANTS`, chạy `db:migrate:wallet`, khởi động lại.

## Phương án đã loại

- Cột `tenant_id` trong bảng chung: mọi truy vấn phải nhớ điều kiện lọc, mọi khóa duy nhất phải mang thêm cột;
  quên một chỗ là lộ dữ liệu.
- Database riêng cho mỗi tenant: cô lập nhất nhưng nhân số kết nối, backup và migration theo số tenant.

## Hệ quả

`Migrator` của Kysely dùng `sp_getapplock` nên cần tài khoản thuộc `db_owner`: migration chạy bằng login migrator
riêng, service chạy bằng login chỉ có DML. Số schema tăng theo số tenant (phù hợp đến vài trăm); không có truy vấn
xuyên tenant — đối soát (Bước 5) lặp qua từng tenant. Danh sách tenant của wallet phải được thống nhất với cấu hình
gateway của ecommerce trước khi chạy thật.
