# Manual test plan: Ops tools (freeze, adjustment, reversal, replay, nhật ký)

> **Giai đoạn 2, nhóm D.** Nhóm API `/ops/...` của wallet cho người vận hành xử lý tình huống tiền bạc: đóng/mở băng ví, điều chỉnh số dư, đảo một giao dịch, phát lại `OrderPaidV1`, xem nhật ký (`README.md` mục Công cụ vận hành; `docs/ops/ops-tools.vi.md`; ADR-0013).
> Môi trường: **local stack**. QA **tự đặt** header `x-actor-*` (đã xác nhận). Được phép ghi dữ liệu và tạm dừng `wallet`.
> **Các route này thay đổi tiền của khách và chỉ dành cho mạng vận hành**; không đưa vào route hướng khách của gateway (`ops-tools.vi.md`, đầu tài liệu). Trên local stack chỉ lắng nghe `127.0.0.1` (`docs/ops/local-stack.vi.md`).
> Mọi "kết quả mong đợi" **đọc từ code và `docs/ops/ops-tools.vi.md`, chưa chạy thật**. Chỗ chưa chắc ghi **[Chưa xác minh]**.

## 1. Chuẩn bị

```bash
W=http://localhost:3001
H='-H x-tenant-id:acme -H x-actor-id:qa.tester -H x-actor-role:OPS -H content-type:application/json'
# Mỗi test: customer id MỚI (ví dụ ops-c001), idempotencyKey MỚI. Ghi lại actionId và transactionId trả về.
```

- Header (`ops.guard.ts:25-47`): `x-actor-id` (1..100 ký tự), `x-actor-role` đúng `OPS`, `x-tenant-id`. Thứ tự kiểm tra: **actor (401), vai trò (403), tenant**. Header nhiều giá trị bị nối lại nên `OPS, ADMIN` không lọt.
- Body phải là **đối tượng JSON**, nếu không `400 INVALID_REQUEST` (`body.ts`). Trường không phải chuỗi coi như rỗng nên lỗi là `422`, không phải `400` (`body.ts:11`).
- Mọi `POST` cần `reason` (1..500 ký tự) và `idempotencyKey` (1..200), cắt khoảng trắng hai đầu (`domain/ops.ts:13-31`).
- Mỗi thao tác **đổi trạng thái** ghi đúng một dòng `ops_actions` cùng transaction; thao tác lỗi hoặc no-op không ghi (`ops-tools.vi.md`, mục Nhật ký).
- Tạo ví và nạp tiền theo `01-manual-wallet-core.md` (WLT-001, TOP-001). Số dư xem bằng `GET /wallet` với header khách (`x-tenant-id`, `x-customer-id`).
- **Quan sát:** `GET /ops/actions`, `GET /wallet`, `GET /wallet/entries`, log wallet. `ops_actions` và `accounts.frozen_*` còn xem được bằng SQL chỉ đọc (schema `t_<tenant>`) nhưng bạn chọn log và Kibana nên SQL là tùy chọn.
- **Khóa ledger (từ code):** `adjustment:<actionId>`, `reversal:<id giao dịch gốc>`, `order:<orderId>`, `topup:<topupId>` (`domain/ledger-transaction.ts:87,111,137,155`). Dùng để nhận diện entry trong `GET /wallet/entries` (`businessKey`).

## 2. Phân loại: manual hay tự động hóa

| Phần | Manual (nên) | Tự động hóa sau | Lý do |
| --- | --- | --- | --- |
| Xác thực/phân quyền header | Một lượt đầu | Postman Regression (nhóm H) | Rẻ và lặp lại |
| Điều chỉnh/đảo số dư, kiểm số dư sau mỗi bước | **Có** | Test integration đã có (`ops.api.integration.test.ts`, `ops.integration.test.ts`) | Tiền thật của khách: cần mắt người kiểm số dư và sổ cái |
| Tương tác freeze với order (`WALLET_FROZEN`) | **Có** | Một phần ở e2e (`tests/e2e/billing.integration.test.ts:270`) | Cần RabbitMQ (nhóm C) |
| Idempotency tuần tự | Một lượt đầu | Postman Regression | Xác định được |
| Idempotency đồng thời (cùng khóa) | **Có** | Test integration đã có | Dùng applock; khó giả lập bằng Postman |
| Nhật ký `ops_actions` (chỉ thêm) | Có kiểm bằng API | Test integration đã có | Kiểm bất biến trigger cần SQL (tùy chọn) |

## 3. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 3.1 Xác thực và phân quyền

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| OPS-001 | Thiếu `x-actor-id` | — | `curl -s -i $W/ops/actions -H x-tenant-id:acme -H x-actor-role:OPS` | `401`, `MISSING_ACTOR` | P1 | R | `ops.guard.ts:36-38` |
| OPS-002 | `x-actor-id` chỉ có khoảng trắng | — | `x-actor-id: "  "` | `401`, `MISSING_ACTOR` | P2 | R | `ops.guard.ts:35-38` (trim) |
| OPS-003 | Vai trò sai | — | `x-actor-role: ADMIN`; `x-actor-role: ops` (chữ thường); thiếu header | `403`, `FORBIDDEN_ROLE` | P1 | R | `ops.guard.ts:39-41`; `ops-tools.vi.md` |
| OPS-004 | Vai trò có nhiều giá trị | — | Gửi `x-actor-role: OPS, ADMIN` (một header) | `403`, `FORBIDDEN_ROLE` | P1 | R | `ops.guard.ts:21-22,39` (nối giá trị); `ops-tools.vi.md` |
| OPS-005 | Thiếu tenant | — | Bỏ `x-tenant-id` | `400`, `MISSING_TENANT` | P1 | R | `ops.guard.ts:42`; `errors.ts` RULES |
| OPS-006 | Tenant lạ | — | `x-tenant-id: zzz` | `403`, `UNKNOWN_TENANT` | P1 | R | `errors.ts` RULES |
| OPS-007 | Thứ tự kiểm tra | — | Gửi thiếu cả actor và tenant | `401 MISSING_ACTOR` (actor kiểm trước) | P3 | R | `ops.guard.ts` ("actor, vai trò, rồi tenant") |
| OPS-008 | Danh tính chỉ lấy từ header, không từ body | Ví có sẵn | `freeze` với body có thêm `"actor":"hacker"` và header `x-actor-id: qa.tester` | `200`; trong `GET /ops/actions` dòng mới có `actor:"qa.tester"` | P1 | R | `ops.controller.ts:25-27` (comment); `ops-tools.vi.md` |
| OPS-009 | Header khách không phải danh tính ops | — | Chỉ gửi `x-customer-id` và `x-tenant-id` tới `/ops/actions` | `401`, `MISSING_ACTOR` | P2 | R | `ops.guard.ts` (comment) |

### 3.2 Freeze / unfreeze

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| FRZ-001 | **Đóng băng ví** | Ví `ops-c001` đã tạo | `curl -s -i -X POST $W/ops/wallets/ops-c001/freeze $H -d '{"reason":"qa test","idempotencyKey":"qa-frz-001"}'` | `200`; `{"customerId":"ops-c001","frozen":true,"changed":true,"frozenAt":"<ISO>","actionId":"<id>"}` | P1 | S | `ops.controller.ts:51-63`; `ops-tools.vi.md` mục Đóng băng |
| FRZ-002 | Đóng băng ví đã đóng băng là no-op | Sau FRZ-001 | Gọi lại với **khóa mới** | `200`, `frozen:true`, `changed:false`, `actionId:null`; **không** thêm dòng `ops_actions` | P1 | R | `freeze-wallet.ts:40-45`; `ops-tools.vi.md` |
| FRZ-003 | Idempotent: gọi lại **cùng khóa** | Sau FRZ-001 | Gửi lại đúng FRZ-001 (cùng khóa, cùng ví) | `200`; trả đúng kết quả cũ (cùng `actionId`, `changed:true`); không thêm dòng nhật ký | P1 | R | `ops-tools.vi.md` mục Idempotency |
| FRZ-004 | **Mở băng ví** | Sau FRZ-001 | `POST /ops/wallets/ops-c001/unfreeze` khóa mới | `200`, `frozen:false`, `changed:true`, `frozenAt:null` | P1 | S | `ops.controller.ts:65-77`; `ops-tools.vi.md` |
| FRZ-005 | Mở băng ví đang mở là no-op | Sau FRZ-004 | Unfreeze lại, khóa mới | `200`, `changed:false`, `actionId:null` | P2 | R | `freeze-wallet.ts` |
| FRZ-006 | Ví không tồn tại | — | freeze `ops-nowallet` | `404`, `WALLET_NOT_FOUND` | P1 | R | `ops-tools.vi.md` |
| FRZ-007 | `customerId` sai định dạng trên đường dẫn | — | `POST /ops/wallets/bad%20id!/freeze` | `400`, `INVALID_REQUEST` | P2 | R | `ops-tools.vi.md` (bảng mã lỗi) |
| FRZ-008 | Thiếu `reason`/`idempotencyKey` | — | Body `{}`; `{"reason":"x"}`; `{"idempotencyKey":"k"}`; chuỗi toàn khoảng trắng; `reason` 501 ký tự | `422`, `INVALID_OPS_REQUEST` | P1 | R | `domain/ops.ts:13-31`; `body.ts:11` |
| FRZ-009 | Body không phải object | — | Body `[]`; `"x"` | `400`, `INVALID_REQUEST` | P2 | R | `body.ts:4-8` |
| FRZ-010 | Cùng khóa, khác ví | Có hai ví | Dùng khóa FRZ-001 để freeze ví khác | `409`, `IDEMPOTENCY_CONFLICT` | P1 | R | `ops-tools.vi.md` mục Idempotency |
| FRZ-011 | Freeze **chặn trả order** | Ví đủ tiền; luồng order (nhóm C) | Freeze rồi publish `OrderReadyForPaymentV1` | `WALLET_FROZEN`; số dư không đổi (xem `ORD-015` ở `03-manual-order-payment.md`) | P1 | S | `pay-order.ts:136`; handoff |
| FRZ-012 | Freeze **không chặn nạp tiền** | Ví đóng băng | `POST /topups` (nhóm A) | Nạp vẫn được nhận và `SUCCEEDED`, số dư tăng | P1 | R | `ops-tools.vi.md` ("Nạp tiền vẫn được nhận") |
| FRZ-013 | Ví đóng băng vẫn đọc được | Ví đóng băng | `GET /wallet`, `GET /wallet/entries` | `200` | P3 | R | suy ra từ mô tả: chỉ ghi nợ trả order bị chặn **[Chưa xác minh]** |
| FRZ-014 | Chỉ ví mới đóng băng được | — | Thử freeze tài khoản hệ thống (nếu route cho phép) | **[Chưa xác minh]** route chỉ nhận `customerId`; nếu `customerId` trùng tên tài khoản hệ thống thì bị `INVALID_REQUEST` do regex customer; ghi lại thực tế | P3 | R | `ops-tools.vi.md` ("Chỉ ví (`WALLET`)") |

### 3.3 Điều chỉnh số dư

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| ADJ-001 | **CREDIT cộng ví** | Ví `ops-c002` `VND`, số dư 0 | `curl -s -i -X POST $W/ops/wallets/ops-c002/adjustments $H -d '{"direction":"CREDIT","amount":50000,"currency":"VND","reason":"qa credit","idempotencyKey":"qa-adj-001"}'` | `201`; `{"transactionId":"tx_...","actionId":"..."}`; `GET /wallet` `balance:50000`; có entry `+50000` với `businessKey:"adjustment:<actionId>"` | P1 | S | `ops.controller.ts:79-95`; `ledger-transaction.ts:122-146` |
| ADJ-002 | **DEBIT trừ ví** | Sau ADJ-001 | `direction:"DEBIT"`, `amount:20000`, khóa mới | `201`; số dư 30000; entry `-20000` | P1 | S | `ops-tools.vi.md` mục Điều chỉnh |
| ADJ-003 | DEBIT vượt số dư | Số dư 30000 | `DEBIT 40000` | `409`, `INSUFFICIENT_FUNDS`; số dư **không đổi**; không có dòng nhật ký, không có entry | P1 | R | `ops-tools.vi.md` (bảng mã lỗi) |
| ADJ-004 | Idempotent: gửi lại cùng khóa và nội dung | Sau ADJ-001 | Gửi lại đúng ADJ-001 | `201` (mã thành công như lần đầu), **cùng `transactionId` và `actionId`**; số dư **không đổi** | P1 | S | `ops-tools.vi.md` mục Idempotency |
| ADJ-005 | Cùng khóa, khác số tiền | Sau ADJ-001 | Cùng khóa, `amount:60000` | `409`, `IDEMPOTENCY_CONFLICT`; số dư không đổi | P1 | R | `ops-tools.vi.md` |
| ADJ-006 | Người vận hành khác gửi cùng khóa và tham số | Sau ADJ-001 | Gửi lại với `x-actor-id: another.person` và `reason` khác | Nhận kết quả lần đầu; **không** có dòng nhật ký mới; dòng cũ vẫn ghi người và lý do lần đầu | P2 | R | `ops-tools.vi.md` ("`reason` và `actor` không nằm trong dấu vân tay") |
| ADJ-007 | `direction` sai | — | `"direction":"UP"`; thiếu `direction` | `422`, `INVALID_OPS_REQUEST` | P1 | R | `ops-tools.vi.md` |
| ADJ-008 | `amount` không hợp lệ | — | `0`; `-5`; `10.5`; `"1000"` (chuỗi); thiếu | `422`, `INVALID_OPS_REQUEST` (không phải số nguyên dương) | P1 | R | `ops.controller.ts:92` (không phải số thành NaN rồi 422); `ledger-transaction.ts:132` |
| ADJ-009 | Sai đồng tiền | Ví `VND` | `"currency":"USD"` | `422`, `INVALID_OPS_REQUEST` | P1 | R | `ops-tools.vi.md` |
| ADJ-010 | Ví không tồn tại | — | adjust cho `ops-nowallet` | `404`, `WALLET_NOT_FOUND` | P1 | R | `ops-tools.vi.md` |
| ADJ-011 | Điều chỉnh trên ví đóng băng vẫn chạy | Ví đóng băng | CREDIT 1000 | `201`, số dư tăng | P2 | R | `ops-tools.vi.md` |
| ADJ-012 | Số lớn | Ví `VND` | `amount:9007199254740991` (số nguyên an toàn lớn nhất) rồi `9007199254740992` | Giá trị đầu có thể được nhận; giá trị sau bị `422` (không phải số nguyên an toàn) **[Chưa xác minh]**: chỉ làm khi bạn muốn kiểm biên | P3 | R | `money.ts:13` |
| ADJ-013 | Tiền khớp sổ cái | Sau ADJ-001/002 | Cộng mọi entry của ví so với `balance` | Bằng nhau | P1 | S | `ledger-transaction.ts:122-146` (hai dòng đối ứng) |

### 3.4 Đảo giao dịch (reversal)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| REV-001 | **Đảo một `ADJUSTMENT`** | Sau ADJ-001 (CREDIT 50000, có `transactionId`) và ví đủ tiền để đảo | `POST /ops/transactions/<transactionId>/reversals $H -d '{"reason":"qa reverse","idempotencyKey":"qa-rev-001"}'` | `201`; `{"transactionId":"tx_...","reversesTransactionId":"<gốc>","actionId":"..."}`; số dư quay về trước CREDIT; có entry đối nghịch với `businessKey:"reversal:<id gốc>"`; **giao dịch gốc không bị sửa** | P1 | S | `ops.controller.ts:97-104`; `ledger-transaction.ts:155`; `ops-tools.vi.md` |
| REV-002 | Mỗi giao dịch chỉ bị đảo một lần | Sau REV-001 | Đảo lại cùng giao dịch, khóa mới | `409`, `ALREADY_REVERSED` | P1 | R | `ops-tools.vi.md` |
| REV-003 | Idempotent: gửi lại cùng khóa | Sau REV-001 | Gửi lại đúng REV-001 | `201`, cùng `transactionId`/`actionId`, số dư không đổi | P1 | R | `ops-tools.vi.md` |
| REV-004 | Đảo khoản trả order | Order đã trả (nhóm C, ORD-001) | Lấy `walletTransactionId` từ `OrderPaidV1`; đảo | `201`; ví được hoàn lại; **không** có sự kiện hoàn tiền nào ra broker (wallet không phát) | P1 | R | `ops-tools.vi.md` ("Đảo thanh toán không phát sự kiện"); handoff |
| REV-005 | Order bị đảo thì gửi lại bị `CONFLICT` | Sau REV-004 | Publish lại `OrderReadyForPaymentV1` cùng `orderId` (eventId mới) | `OrderPaymentFailedV1` `CONFLICT`; ví không bị trừ; log cảnh báo "order payment was reversed; refusing re-delivered order" | P1 | R | `pay-order.ts:99-109` |
| REV-006 | Không đảo được `TOPUP` | Có giao dịch nạp (nhóm A) | Đảo `transactionId` của topup | `409`, `REVERSAL_NOT_SUPPORTED` | P1 | R | `ops-tools.vi.md` mục Hạn chế |
| REV-007 | Không đảo được `REVERSAL` | Sau REV-001 | Đảo `transactionId` của giao dịch đảo | `409`, `REVERSAL_NOT_SUPPORTED` | P1 | R | `ops-tools.vi.md` |
| REV-008 | Giao dịch không tồn tại | — | `.../transactions/tx_doesnotexist/reversals` | `404`, `TRANSACTION_NOT_FOUND` | P1 | R | `ops-tools.vi.md` |
| REV-009 | Đảo `ADJUSTMENT CREDIT` khi ví đã tiêu hết | ADJ CREDIT 50000 rồi tiêu hết (DEBIT hoặc order) | Đảo CREDIT | `409`, `INSUFFICIENT_FUNDS` (ví không đủ); không ghi gì | P1 | R | `ops-tools.vi.md` (bảng mã lỗi) |
| REV-010 | `REVERSAL_NOT_POSSIBLE` | Cần MERCHANT không đủ số dư để hoàn: khó dựng bằng tay **[Chưa xác minh]** | Đề xuất bỏ khỏi manual; đã có test integration (`ops.integration.test.ts`) | Cả hai (`REVERSAL_NOT_POSSIBLE`, `INSUFFICIENT_FUNDS`) đều rollback hoàn toàn | P3 | R | `ops-tools.vi.md` ("Phân biệt hai mã dễ nhầm") |
| REV-011 | Đảo chạy được trên ví đóng băng | Ví đóng băng, có giao dịch đảo được | Đảo | `201` | P3 | R | `ops-tools.vi.md` |
| REV-012 | Hai yêu cầu đảo đồng thời **khác khóa** | Một giao dịch | Bắn 2-5 `POST reversals` song song, mỗi cái khóa riêng | Đúng **một** `201`; còn lại `409 ALREADY_REVERSED`; số dư chỉ đổi một lần | P1 | R | `ops-tools.vi.md` ("chỉ mục unique có lọc là chốt cuối khi chạy song song") |

### 3.5 Phát lại `OrderPaidV1`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| RPL-001 | **Phát lại sự kiện đã trả** | Order đã trả (ORD-001); queue `ecommerce.qa-results` (nhóm C) | `POST /ops/orders/<orderId>/replay-paid $H -d '{"reason":"qa replay","idempotencyKey":"qa-rpl-001"}'` | `202`; `{"eventId":"<eventId gốc>","actionId":"..."}`; message `order-paid.v1` mới trong queue với **cùng `eventId` và `occurredAtUtc`/`paidAtUtc` gốc**, `correlationId:"ops-replay:<actionId>"`; **số dư không đổi**, không có entry mới | P1 | S | `ops.controller.ts:106-110`; `ops-tools.vi.md` mục Phát lại |
| RPL-002 | Order chưa trả | — | replay cho UUID lạ | `404`, `ORDER_NOT_FOUND` | P1 | R | `ops-tools.vi.md` |
| RPL-003 | Order đã bị đảo | Sau REV-004 | replay | `409`, `ORDER_REVERSED`; không có message ra broker | P1 | R | `ops-tools.vi.md` |
| RPL-004 | Idempotent theo khóa | Sau RPL-001 | Gửi lại đúng RPL-001 | `202`, cùng `eventId`/`actionId`; **không** thêm message mới trong queue | P1 | R | `ops-tools.vi.md` mục Idempotency |
| RPL-005 | `eventId` gốc không còn | Order trả trước migration 007 và outbox đã dọn | Khó dựng ở local **[Chưa xác minh]** | `409`, `EVENT_ID_UNKNOWN` | P3 | R | `ops-tools.vi.md` mục Hạn chế |
| RPL-006 | `messageId` AMQP mới, `eventId` giữ nguyên | Sau RPL-001 | Trong management xem message: thuộc tính `message_id` và payload `eventId` | `message_id` **khác** `eventId` (là id outbox mới), payload `eventId` bằng `eventId` gốc | P2 | R | `ops-tools.vi.md` (khung "eventId giữ nguyên, nhưng messageId thì mới"); handoff |

### 3.6 Nhật ký `ops_actions`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| LOG-001 | Xem nhật ký | Đã chạy một số case trên | `curl -s "$W/ops/actions?limit=20" $H` | `200`; `{"items":[{"id","action","actor","reason","target","createdAt"}],"nextCursor":...}`; **mới nhất trước**; **không** có `idempotencyKey`, `fingerprint`, `result` | P1 | S | `ops.controller.ts:112-125`; `ops-tools.vi.md` mục Xem nhật ký |
| LOG-002 | Mỗi thao tác đổi trạng thái có đúng một dòng | Trước/sau các thao tác đã làm | Đếm dòng theo `target` (`wallet:ops-c001`, `transaction:<id>`, `order:<id>`) | Số dòng khớp số thao tác đổi trạng thái: FRZ-001 (1), FRZ-004 (1), no-op (0), thao tác lỗi (0), replay cùng khóa (0) | P1 | R | `ops-tools.vi.md` mục Nhật ký |
| LOG-003 | Loại thao tác | Sau các thao tác | Xem `action` | Thuộc `FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID` | P2 | R | `domain/ops.ts:1`; `ops-tools.vi.md` |
| LOG-004 | Phân trang | ≥ 3 dòng | `limit=1`, rồi dùng `nextCursor` | Mỗi trang 1 dòng, thứ tự giảm dần theo `seq`, trang cuối `nextCursor:null` | P2 | R | `ops-tools.vi.md` |
| LOG-005 | `limit`/`cursor` sai | — | `limit=0`, `201`, `abc`; `cursor=abc`, `cursor=0`; lặp `?limit=1&limit=2` | `400`, `INVALID_QUERY` (`limit` 1..200) | P2 | R | `ops.controller.ts:118-120`; `ops-tools.vi.md` |
| LOG-006 | Nhật ký cách ly theo tenant | Có thao tác ở `acme` | `GET /ops/actions` với `x-tenant-id:beta` | Không thấy dòng của `acme` | P1 | R | `ops-tools.vi.md` (bảng nằm trong schema `t_<tenant>`) |
| LOG-007 | Nhật ký chỉ thêm | Tùy chọn, cần SQL (bạn chọn log/Kibana nên có thể bỏ) | `UPDATE`/`DELETE` thử trên `t_acme.ops_actions` | Lỗi `ops_actions is append-only` (trigger `trg_ops_actions_append_only`) | P3 | R | `ops-tools.vi.md` mục Nhật ký |
| LOG-008 | Khóa idempotency cô lập theo tenant | Hai tenant | Cùng khóa và cùng tham số ở `acme` và `beta` | Hai thao tác độc lập, mỗi nơi một dòng nhật ký | P2 | R | `ops-tools.vi.md` ("Khóa chỉ có nghĩa trong một tenant") |

### 3.7 Đồng thời và chịu lỗi

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại | Truy vết / Cơ sở |
| --- | --- | --- | --- | --- | --- | --- | --- |
| CON-001 | Hai yêu cầu cùng khóa đồng thời được tuần tự hóa | Ví có sẵn | Bắn 5 `POST adjustments` song song, **cùng khóa và nội dung** (`for i in 1 2 3 4 5; do curl ... & done; wait`) | Số dư thay đổi **đúng một lần**; mọi phản hồi cùng `transactionId`/`actionId`; chỉ một dòng nhật ký | P1 | R | `ops-tools.vi.md` ("tuần tự hóa theo khóa" bằng `sp_getapplock`) |
| CON-002 | Freeze song song cùng khóa | Ví có sẵn | 5 `freeze` song song cùng khóa | Tất cả `200` cùng `actionId`, `changed:true` (kể cả bên đến sau); một dòng nhật ký | P1 | R | `ops-tools.vi.md` |
| CON-003 | Đảo và replay cùng order song song | Order đã trả | Bắn `reversals` và `replay-paid` gần như cùng lúc (khóa riêng) | Hoặc replay trước rồi đảo, hoặc đảo trước thì replay `409 ORDER_REVERSED`; **không bao giờ** có `OrderPaidV1` được xếp hàng cho khoản đã đảo | P2 | R | `ops-tools.vi.md` ("tuần tự hóa bằng khóa ví") |
| CON-004 | Wallet dừng giữa chừng không để lại trạng thái dở | Được phép dừng wallet | Bắn một adjust rồi `stop wallet` ngay; `start`; gửi lại **cùng khóa** | Kết quả cuối cùng nhất quán: hoặc thao tác chưa xảy ra (số dư cũ, thực hiện lại bình thường) hoặc đã xảy ra đúng một lần (gửi lại trả kết quả cũ) | P2 | R | `ops-tools.vi.md` (cùng transaction); ADR-0013 |

## 4. Bộ Smoke đề xuất

`OPS-001`, `OPS-003`, `FRZ-001`, `FRZ-004`, `FRZ-011`, `ADJ-001`, `ADJ-004`, `ADJ-013`, `REV-001`, `RPL-001`, `LOG-001`.

## 5. Kết quả thực thi (điền khi chạy)

| ID | Ngày | Người test | Kết quả (Pass/Fail/Blocked) | Giá trị thực tế khi khác mong đợi | Defect |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

## 6. Câu hỏi còn mở (riêng nhóm này)

1. **FRZ-013, FRZ-014**: hành vi đọc trên ví đóng băng và việc freeze tài khoản hệ thống tôi chưa đọc đủ code (`freeze-wallet.ts`); ghi nhận khi chạy.
2. **REV-010, RPL-005**: khó dựng bằng tay; đề nghị bỏ khỏi manual và dựa vào test integration. Bạn đồng ý không?
3. **LOG-007**: kiểm trigger append-only cần SQL; bạn chọn log/Kibana nên mặc định **bỏ**. Xác nhận.
4. **ADJ-012**: kiểm biên số nguyên lớn có cần không (P3)?
5. Sau nhóm D, theo thứ tự bạn xác nhận: **E (đối soát)**, rồi **F (retention)**.
