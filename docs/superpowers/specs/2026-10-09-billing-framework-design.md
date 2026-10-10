# Billing Framework — Thiết kế nền tảng

**Ngày:** 2026-10-09
**Trạng thái:** Chờ duyệt
**Phạm vi:** Sub-project 1 — cấu trúc repo, design pattern, nguyên tắc, hợp đồng giao tiếp với ecommerce. Logic chi tiết từng service có spec riêng (xem Lộ trình).

## 1. Bối cảnh và mục tiêu

`billing-framework` là **repo độc lập**, không nằm trong repo ecommerce. Gồm hai microservice:

- **payment** — giả lập cổng thanh toán tiền thật.
- **wallet** — ví nạp trước (stored-value). Trừ số dư để thanh toán các order đã hoàn tất ở `orders` qua luồng bất đồng bộ; sau khi trả xong, `orders` đổi trạng thái `Unpaid → Paid`.

Yêu cầu bắt buộc của wallet: **chống thanh toán trùng** và **đối soát (consolidation)** để số tiền wallet khớp với payment gateway.

### Các quyết định đã chốt

| # | Quyết định | Lựa chọn |
|---|---|---|
| 1 | Giao tiếp với ecommerce | Hợp đồng JSON thuần qua RabbitMQ, độc lập MassTransit envelope |
| 2 | Mô hình tiền | Ví nạp trước: nạp qua payment → số dư; trả order bằng cách trừ số dư |
| 3 | Framework | wallet: NestJS; payment: Fastify; cả hai TypeScript strict |
| 4 | Truy cập dữ liệu | Kysely (SQL-first) trên SQL Server; migration SQL tường minh |
| 5 | Thiếu tiền | Từ chối ngay (`OrderPaymentFailedV1`), order giữ `Unpaid`; không có trạng thái treo |
| 6 | Hạ tầng | Lai: dùng chung nền tảng (K8s, CI, observability, Vault); DB, user SQL, vhost RabbitMQ riêng |
| 7 | Mô hình sổ | Ledger ghi sổ kép bất biến; số dư là cache kiểm chứng được |
| 8 | Repo | Repo riêng, tách hẳn khỏi repo ecommerce |

## 2. Cấu trúc repo

Monorepo pnpm workspaces (chạy qua `corepack pnpm`), TypeScript strict.

```
billing-framework/
├─ services/
│  ├─ wallet/            # NestJS: ví, ledger, thanh toán order, đối soát
│  └─ payment/           # Fastify: giả lập cổng thanh toán
├─ packages/
│  ├─ contracts/         # JSON Schema + type sinh ra: event, API (nguồn sự thật duy nhất)
│  ├─ messaging/         # RabbitMQ client, publisher, consumer, retry/DLQ
│  ├─ outbox/            # transactional outbox + relay (Kysely)
│  ├─ idempotency/       # idempotency key + processed_messages
│  ├─ money/             # Money: số nguyên minor unit + currency, không dùng float
│  ├─ observability/     # OpenTelemetry, logger, correlation id
│  └─ testing/           # testcontainers, fake gateway, helper contract test
├─ db/                   # migration Kysely theo từng service
├─ deploy/               # compose overlay, manifest K8s
├─ docs/                 # adr/, architecture/, runbooks/ (tiếng Việt, đuôi .vi.md)
├─ pacts/                # contract test với ecommerce
└─ Jenkinsfile
```

### Nguyên tắc cấu trúc

- Mỗi service có 4 lớp: `domain` (thuần, không import hạ tầng), `application` (use case, port), `infrastructure` (adapter DB/broker/HTTP), `interface` (controller, consumer).
- Lint rule (eslint boundaries) cấm `domain` import `infrastructure`; cấm service này import code service kia. Giao tiếp giữa service chỉ qua `contracts`.
- Mỗi package dùng chung có API công khai rõ ràng; không import sâu vào file nội bộ.

### Vì sao repo riêng ảnh hưởng thiết kế

- **Contract là sản phẩm được phát hành.** `packages/contracts` được phát hành thành package có phiên bản (registry nội bộ hoặc git tag). Team ecommerce lấy JSON Schema từ đó để validate/sinh model C#; không sao chép tay, không tham chiếu đường dẫn tới repo khác.
- **Không có tham chiếu file chéo repo.** Compose overlay nối vào hạ tầng ecommerce qua network/host cấu hình (biến môi trường), không qua đường dẫn thư mục.
- **Pact Broker dùng chung** là điểm gặp của hai repo: mỗi bên publish pact/verification độc lập, lỗi hợp đồng làm hỏng build của bên phát.

## 3. Kiến trúc từng service

### Wallet (NestJS)

Module theo bounded context, mỗi module là một lát hexagonal: `accounts`, `ledger`, `topups`, `order-payments`, `reconciliation`.

- **Aggregate `Wallet`** là ranh giới nhất quán; mọi thay đổi số dư chỉ đi qua aggregate này.
- **Ledger ghi sổ kép bất biến**: giao dịch gồm các dòng nợ/có, tổng bằng 0, chỉ ghi thêm. Sai thì ghi bút toán đảo (`REVERSAL`).
- **CQRS nhẹ** (`@nestjs/cqrs`): command ghi tách query đọc; không event sourcing.
- **Transactional outbox**: bút toán và event ghi trong cùng transaction SQL; relay riêng đẩy lên RabbitMQ. Use case không publish trực tiếp.
- **Inbox (`processed_messages`)**: ghi cùng transaction với bút toán.
- **Repository + Unit of Work**: port ở `application`, adapter Kysely ở `infrastructure`.
- **Money value object**: số nguyên minor unit + currency; mọi phép tính qua `packages/money`.
- **Đồng thời**: `UPDLOCK` hoặc kiểm tra `version`; `CHECK (balance >= 0)` ở DB là lớp bảo vệ cuối.

### Payment (Fastify)

Cùng 4 lớp, gọn hơn:

- `gateway`: tạo `charge` với trạng thái `PENDING → SUCCEEDED | FAILED`.
- **Kịch bản giả lập điều khiển được** theo số tiền hoặc header (thành công, thất bại, trả chậm, timeout) để test tình huống lỗi. Quy ước cụ thể do spec payment định nghĩa.
- **Webhook ký HMAC** về wallet khi charge hoàn tất; retry với backoff.
- **`Idempotency-Key` bắt buộc** trên `POST /charges`: cùng key trả cùng kết quả.
- `GET /settlements?date=` trả sao kê cuối ngày — nguồn dữ liệu đối soát.

### Chung

DB riêng, user SQL riêng; health/readiness endpoint; log có `correlationId`; cấu hình qua biến môi trường (secret từ Vault).

## 4. Luồng event và hợp đồng với ecommerce

### Broker

- Vhost riêng `billing` trên RabbitMQ dùng chung; user riêng cho từng service.
- Exchange `topic`: `orders.events` (ecommerce sở hữu), `billing.events` (billing sở hữu). Mỗi bên chỉ publish vào exchange của mình, chỉ consume từ exchange của bên kia.
- Mỗi consumer có queue riêng, retry queue (backoff) và DLQ.

### Hình dạng event (JSON phẳng, theo quy ước của ecommerce)

Mỗi event là một JSON phẳng như `OrderPlacedV1` của ecommerce: `eventId`, `occurredAtUtc`, `tenantId`, `correlationId` cùng
các trường nghiệp vụ; không có envelope (xem ADR-0008). Version nằm trong tên event (`OrderPaidV1`, schema
`OrderPaid.v1.schema.json`) và routing key (`order-paid.v1`). Thêm trường tùy chọn là tương thích; đổi nghĩa hoặc thêm
trường bắt buộc thì tạo `V2` chạy song song. Người nhận theo "tolerant reader". Chi tiết ở
`docs/superpowers/specs/2026-10-10-order-payment-integration-design.md`.

### Event luồng thanh toán order

| Event | Bên phát | Bên nhận | Ý nghĩa |
|---|---|---|---|
| `OrderReadyForPaymentV1` | orders | wallet | Order hoàn tất, cần thu tiền. Trường nghiệp vụ: `orderId`, `customerId`, `amount`, `currency` |
| `OrderPaidV1` | wallet | orders | Đã trừ tiền. `orderId`, `walletTransactionId`, `amount`, `currency`, `paidAtUtc` |
| `OrderPaymentFailedV1` | wallet | orders | Từ chối. `orderId`, `reason` (`INSUFFICIENT_FUNDS`, `WALLET_NOT_FOUND`, `CURRENCY_MISMATCH`, `CONFLICT`) |

### Nạp tiền (nội bộ billing)

Wallet gọi payment `POST /charges` (HTTP, có idempotency key); payment trả kết quả bằng webhook `charge.succeeded` / `charge.failed` ký HMAC. Wallet ghi bút toán nạp khi nhận `charge.succeeded`.

### Idempotency của luồng order

Khóa chống trùng là `orderId`. Nhận lại `OrderReadyForPaymentV1` cho order đã trả thì **không trừ thêm**, phát lại `OrderPaidV1` cùng `walletTransactionId`.

### Phần việc cho team ecommerce

1. Thêm trạng thái `Unpaid`/`Paid` cho Order (nếu chưa có); chuyển `Unpaid → Paid` chỉ khi nhận `OrderPaidV1`, bỏ qua nếu đã `Paid`.
2. Publish `OrderReadyForPaymentV1` qua outbox khi order hoàn tất (phụ thuộc SCRUM-18/31, ADR-0011 của ecommerce).
3. Adapter RabbitMQ nói JSON thuần cho 3 event trên.
4. Xử lý `OrderPaymentFailedV1`: ghi nhận lý do, order giữ `Unpaid`.
5. Pact hai chiều, publish lên Pact Broker.
6. Lấy schema từ package `contracts` của billing.

## 5. Chống thanh toán trùng

Nhiều lớp phòng thủ; lớp cuối ở DB.

| Lớp | Chặn | Cách làm |
|---|---|---|
| 1. Inbox | Broker giao lại message | `processed_messages(message_id, consumer)` unique, ghi cùng transaction với bút toán |
| 2. Khóa nghiệp vụ | Yêu cầu lặp | Bút toán `ORDER_PAYMENT` có `business_key = orderId`, unique index; trùng thì trả lại kết quả cũ |
| 3. Đồng thời | Race giữa consumer | Trừ tiền trong transaction với `UPDLOCK` / `version`; bên thua đọc thấy bút toán đã có |
| 4. Idempotency key API | Gọi API lặp | `Idempotency-Key` bắt buộc cho nạp tiền và `POST /charges`; lưu `(key, request_hash, response)`; cùng key khác nội dung → `422` |
| 5. Dedup webhook | Webhook gửi lại | Khóa `chargeId + eventType` |
| 6. Ràng buộc DB | Lỗi code lọt qua | `CHECK (balance >= 0)`, unique index, user ứng dụng không có quyền `UPDATE/DELETE` trên `ledger_entries` |

**Xử lý khi gặp trùng.** Trùng hợp lệ (đã xử lý thành công) → trả lại kết quả cũ, không lỗi. Trùng `orderId` nhưng khác số tiền → không trừ tiền, phát `OrderPaymentFailedV1` với `CONFLICT`, ghi cảnh báo.

**Chứng minh bằng test.** Bắn cùng một message N lần song song → đúng 1 bút toán trừ tiền. Kill consumer sau khi ghi bút toán, trước khi ack, rồi khởi động lại → vẫn đúng 1 bút toán.

## 6. Đối soát (consolidation)

### Ba phép kiểm tra

1. **Nội bộ ledger.** Tổng các dòng của mỗi giao dịch bằng 0; số dư cache của mỗi ví bằng tổng sổ cái của ví đó. Lệch là lỗi toàn vẹn dữ liệu, cảnh báo mức cao nhất.
2. **Wallet ↔ Gateway.** Định kỳ và theo yêu cầu, lấy `GET /settlements?date=` và so với các bút toán `TOPUP` theo `chargeId`:
   - Khớp: cùng `chargeId`, số tiền, trạng thái.
   - Có ở gateway, thiếu ở wallet (mất webhook): tự ghi bù qua đường nạp tiền bình thường (vẫn chống trùng).
   - Có ở wallet, thiếu ở gateway: không tự sửa, tạo ca xử lý thủ công.
   - Lệch số tiền/trạng thái: không tự sửa, tạo ca xử lý thủ công.
   - Tổng kiểm: tổng tiền nạp trong ngày ở gateway bằng tổng `TOPUP` ở wallet.
3. **Wallet ↔ Orders.** Mọi bút toán `ORDER_PAYMENT` phải có order `Paid` tương ứng và ngược lại. Thiếu event thì phát lại `OrderPaidV1` từ outbox. Cần một API đọc hoặc snapshot phía orders; hình thức cụ thể chốt trong spec đối soát cùng team ecommerce.

### Mô hình lưu

`reconciliation_runs` (ngày, trạng thái, tổng kiểm) và `reconciliation_items` (dòng lệch, loại lệch, trạng thái xử lý). Mỗi run bất biến; chạy lại tạo run mới, không ghi đè.

### Nguyên tắc vận hành

- Mặc định chỉ đọc. Chỉ tự sửa loại lệch an toàn, chứng minh được (thiếu bút toán nạp đã được gateway xác nhận).
- Sửa sai luôn bằng bút toán đảo/bù có ghi chú và người thực hiện; không sửa dòng cũ.
- Metric và cảnh báo: số mục lệch, tuổi mục lệch lâu nhất, lần chạy cuối thành công.
- Kích hoạt bằng CronJob K8s và endpoint nội bộ chỉ cho vai trò vận hành.

## 7. Kiểm thử, CI/CD, triển khai

### Kiểm thử

| Tầng | Nội dung | Công cụ |
|---|---|---|
| Unit | Domain thuần (Wallet, Money, ledger) | Vitest |
| Integration | Use case + SQL Server + RabbitMQ thật | Vitest + testcontainers |
| Contract | Event/API với ecommerce, hai chiều | JSON Schema + Pact (Pact Broker dùng chung) |
| Concurrency/Chaos | Race, kill consumer, message giao lại | Test song song, fault injection |
| E2E | Nạp tiền → trả order → `Paid`, gồm nhánh thiếu tiền | Postman/Newman |
| Reconciliation | Dựng lệch có chủ đích, kỳ vọng phân loại đúng | Kịch bản với payment giả lập |

TDD cho domain/ledger; coverage ngưỡng cao cho `domain` và `ledger`; mỗi bug đối soát thêm test tái hiện trước khi sửa.

### CI/CD

- Jenkins + SonarQube dùng chung với nền tảng hiện có, pipeline riêng của repo billing.
- Các bước: install (`corepack pnpm`) → lint + ranh giới → typecheck → unit → integration → contract → build image → quality gate. Chỉ build/test package bị ảnh hưởng.
- Lỗi contract làm hỏng build của bên phát.
- Migration chạy như bước riêng trước khi triển khai, tương thích lùi (expand/contract).

### Triển khai

- Cùng cụm K8s, namespace `billing`; ESO + Vault cấp secret; mỗi service có DB, user SQL, user RabbitMQ riêng.
- Compose overlay `deploy/compose.billing.yml` cho local, nối vào hạ tầng ecommerce qua network và host cấu hình bằng biến môi trường.
- Feature flag Unleash để bật dần luồng `OrderReadyForPaymentV1`; rollback không cần redeploy.
- OpenTelemetry → Elastic; `correlationId` xuyên suốt từ order tới bút toán.

## 8. Lộ trình (mỗi bước: spec → plan riêng)

1. **Nền tảng repo** (spec này): khung monorepo, packages dùng chung, lint ranh giới, CI, compose overlay, ADR.
2. **Payment simulator**: charge, webhook, kịch bản lỗi, settlements.
3. **Wallet core**: accounts, ledger, nạp tiền, chống trùng.
4. **Tích hợp order**: hợp đồng event, outbox/inbox, phối hợp team ecommerce + Pact.
5. **Đối soát**: ba phép kiểm tra, job lập lịch, cảnh báo.
6. **Vận hành**: chaos, dashboard, runbook, tối ưu.

## 9. Ngoài phạm vi phiên bản đầu (YAGNI)

Hoàn tiền, quy đổi đa tiền tệ, giữ chỗ/chờ khi thiếu tiền, event sourcing, nhiều cổng thanh toán thật.

## 10. Câu hỏi mở (không chặn spec này)

- Registry để phát hành `packages/contracts` (npm nội bộ hay git tag) — chốt ở bước 1 của lộ trình.
- Hình thức API/snapshot phía orders cho phép kiểm tra Wallet ↔ Orders — chốt cùng team ecommerce ở bước 4/5.
- Quy ước kịch bản lỗi của payment simulator — chốt ở bước 2.
