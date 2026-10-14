# Test case: Ops tools (freeze, adjustment, reversal, replay, nhật ký)

Nhóm API `/ops/...` của wallet cho người vận hành xử lý tình huống tiền bạc: đóng/mở băng ví, điều chỉnh số dư, đảo một giao dịch, phát lại `OrderPaidV1`, xem nhật ký. Các route này **thay đổi tiền của khách và chỉ dành cho mạng vận hành**; không đưa vào route hướng khách. Trên local stack chỉ lắng nghe `127.0.0.1`. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md).

## 1. Chuẩn bị

```bash
W=http://localhost:3001
H='-H x-tenant-id:acme -H x-actor-id:qa.tester -H x-actor-role:OPS -H content-type:application/json'
# Mỗi test: customer id MỚI (ví dụ ops-c001), idempotencyKey MỚI. Ghi lại actionId và transactionId trả về.
```

- Header: `x-actor-id` (1..100 ký tự), `x-actor-role` đúng `OPS`, `x-tenant-id`. Thứ tự kiểm tra: **actor (401), vai trò (403), tenant**. Header nhiều giá trị bị nối lại nên `OPS, ADMIN` không lọt.
- Body phải là **đối tượng JSON**, nếu không `400 INVALID_REQUEST`. Trường không phải chuỗi coi như rỗng nên lỗi là `422`, không phải `400`.
- Mọi `POST` cần `reason` (1..500 ký tự) và `idempotencyKey` (1..200), cắt khoảng trắng hai đầu.
- Mỗi thao tác **đổi trạng thái** ghi đúng một dòng `ops_actions` cùng transaction; thao tác lỗi hoặc no-op không ghi.
- Tạo ví và nạp tiền theo [`wallet.md`](wallet.md) (WLT-001, TOP-001). Số dư xem bằng `GET /wallet` với header khách (`x-tenant-id`, `x-customer-id`).
- **Quan sát:** `GET /ops/actions`, `GET /wallet`, `GET /wallet/entries`, log wallet.
- **Khóa sổ cái:** `adjustment:<actionId>`, `reversal:<id giao dịch gốc>`, `order:<orderId>`, `topup:<topupId>`. Dùng để nhận diện entry trong `GET /wallet/entries` (`businessKey`).

## 2. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 2.1 Xác thực và phân quyền

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| OPS-001 | Thiếu `x-actor-id` | — | `curl -s -i $W/ops/actions -H x-tenant-id:acme -H x-actor-role:OPS` | `401`, `MISSING_ACTOR` | P1 | R |
| OPS-002 | `x-actor-id` chỉ có khoảng trắng | — | `x-actor-id: "  "` | `401`, `MISSING_ACTOR` | P2 | R |
| OPS-003 | Vai trò sai | — | `x-actor-role: ADMIN`; `x-actor-role: ops` (chữ thường); thiếu header | `403`, `FORBIDDEN_ROLE` | P1 | R |
| OPS-004 | Vai trò có nhiều giá trị | — | Gửi `x-actor-role: OPS, ADMIN` (một header) | `403`, `FORBIDDEN_ROLE` | P1 | R |
| OPS-005 | Thiếu tenant | — | Bỏ `x-tenant-id` | `400`, `MISSING_TENANT` | P1 | R |
| OPS-006 | Tenant lạ | — | `x-tenant-id: zzz` | `403`, `UNKNOWN_TENANT` | P1 | R |
| OPS-007 | Thứ tự kiểm tra | — | Gửi thiếu cả actor và tenant | `401 MISSING_ACTOR` (actor kiểm trước) | P3 | R |
| OPS-008 | Danh tính chỉ lấy từ header, không từ body | Ví có sẵn | `freeze` với body có thêm `"actor":"hacker"` và header `x-actor-id: qa.tester` | `200`; trong `GET /ops/actions` dòng mới có `actor:"qa.tester"` | P1 | R |
| OPS-009 | Header khách không phải danh tính ops | — | Chỉ gửi `x-customer-id` và `x-tenant-id` tới `/ops/actions` | `401`, `MISSING_ACTOR` | P2 | R |

### 2.2 Freeze / unfreeze

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| FRZ-001 | **Đóng băng ví** | Ví `ops-c001` đã tạo | `curl -s -i -X POST $W/ops/wallets/ops-c001/freeze $H -d '{"reason":"qa test","idempotencyKey":"qa-frz-001"}'` | `200`; `{"customerId":"ops-c001","frozen":true,"changed":true,"frozenAt":"<ISO>","actionId":"<id>"}` | P1 | S |
| FRZ-002 | Đóng băng ví đã đóng băng là no-op | Sau FRZ-001 | Gọi lại với **khóa mới** | `200`, `frozen:true`, `changed:false`, `actionId:null`; **không** thêm dòng `ops_actions` | P1 | R |
| FRZ-003 | Idempotent: gọi lại **cùng khóa** | Sau FRZ-001 | Gửi lại đúng FRZ-001 (cùng khóa, cùng ví) | `200`; trả đúng kết quả cũ (cùng `actionId`, `changed:true`); không thêm dòng nhật ký | P1 | R |
| FRZ-004 | **Mở băng ví** | Sau FRZ-001 | `POST /ops/wallets/ops-c001/unfreeze` khóa mới | `200`, `frozen:false`, `changed:true`, `frozenAt:null` | P1 | S |
| FRZ-005 | Mở băng ví đang mở là no-op | Sau FRZ-004 | Unfreeze lại, khóa mới | `200`, `changed:false`, `actionId:null` | P2 | R |
| FRZ-006 | Ví không tồn tại | — | freeze `ops-nowallet` | `404`, `WALLET_NOT_FOUND` | P1 | R |
| FRZ-007 | `customerId` sai định dạng trên đường dẫn | — | `POST /ops/wallets/bad%20id!/freeze` | `400`, `INVALID_REQUEST` | P2 | R |
| FRZ-008 | Thiếu `reason`/`idempotencyKey` | — | Body `{}`; `{"reason":"x"}`; `{"idempotencyKey":"k"}`; chuỗi toàn khoảng trắng; `reason` 501 ký tự | `422`, `INVALID_OPS_REQUEST` | P1 | R |
| FRZ-009 | Body không phải object | — | Body `[]`; `"x"` | `400`, `INVALID_REQUEST` | P2 | R |
| FRZ-010 | Cùng khóa, khác ví | Có hai ví | Dùng khóa FRZ-001 để freeze ví khác | `409`, `IDEMPOTENCY_CONFLICT` | P1 | R |
| FRZ-011 | Freeze **chặn trả order** | Ví đủ tiền; luồng order ([`order-payment.md`](order-payment.md)) | Freeze rồi publish `OrderReadyForPaymentV1` | `WALLET_FROZEN`; số dư không đổi (xem `ORD-015` ở [`order-payment.md`](order-payment.md)) | P1 | S |
| FRZ-012 | Freeze **không chặn nạp tiền** | Ví đóng băng | `POST /topups` ([`wallet.md`](wallet.md)) | Nạp vẫn được nhận và `SUCCEEDED`, số dư tăng | P1 | R |
| FRZ-013 | Ví đóng băng vẫn đọc được | Ví đóng băng | `GET /wallet`, `GET /wallet/entries` | `200` | P3 | R |
| FRZ-014 | Chỉ ví mới đóng băng được | — | Thử freeze tài khoản hệ thống (nếu route cho phép) | Route chỉ nhận `customerId`; ghi lại phản hồi thực tế khi thử một id không phải ví khách | P3 | R |

### 2.3 Điều chỉnh số dư

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| ADJ-001 | **CREDIT cộng ví** | Ví `ops-c002` `VND`, số dư 0 | `curl -s -i -X POST $W/ops/wallets/ops-c002/adjustments $H -d '{"direction":"CREDIT","amount":50000,"currency":"VND","reason":"qa credit","idempotencyKey":"qa-adj-001"}'` | `201`; `{"transactionId":"tx_...","actionId":"..."}`; `GET /wallet` `balance:50000`; có entry `+50000` với `businessKey:"adjustment:<actionId>"` | P1 | S |
| ADJ-002 | **DEBIT trừ ví** | Sau ADJ-001 | `direction:"DEBIT"`, `amount:20000`, khóa mới | `201`; số dư 30000; entry `-20000` | P1 | S |
| ADJ-003 | DEBIT vượt số dư | Số dư 30000 | `DEBIT 40000` | `409`, `INSUFFICIENT_FUNDS`; số dư **không đổi**; không có dòng nhật ký, không có entry | P1 | R |
| ADJ-004 | Idempotent: gửi lại cùng khóa và nội dung | Sau ADJ-001 | Gửi lại đúng ADJ-001 | `201` (mã thành công như lần đầu), **cùng `transactionId` và `actionId`**; số dư **không đổi** | P1 | S |
| ADJ-005 | Cùng khóa, khác số tiền | Sau ADJ-001 | Cùng khóa, `amount:60000` | `409`, `IDEMPOTENCY_CONFLICT`; số dư không đổi | P1 | R |
| ADJ-006 | Người vận hành khác gửi cùng khóa và tham số | Sau ADJ-001 | Gửi lại với `x-actor-id: another.person` và `reason` khác | Nhận kết quả lần đầu; **không** có dòng nhật ký mới; dòng cũ vẫn ghi người và lý do lần đầu | P2 | R |
| ADJ-007 | `direction` sai | — | `"direction":"UP"`; thiếu `direction` | `422`, `INVALID_OPS_REQUEST` | P1 | R |
| ADJ-008 | `amount` không hợp lệ | — | `0`; `-5`; `10.5`; `"1000"` (chuỗi); thiếu | `422`, `INVALID_OPS_REQUEST` (không phải số nguyên dương) | P1 | R |
| ADJ-009 | Sai đồng tiền | Ví `VND` | `"currency":"USD"` | `422`, `INVALID_OPS_REQUEST` | P1 | R |
| ADJ-010 | Ví không tồn tại | — | adjust cho `ops-nowallet` | `404`, `WALLET_NOT_FOUND` | P1 | R |
| ADJ-011 | Điều chỉnh trên ví đóng băng vẫn chạy | Ví đóng băng | CREDIT 1000 | `201`, số dư tăng | P2 | R |
| ADJ-012 | Số lớn | Ví `VND` | `amount:9007199254740991` (số nguyên an toàn lớn nhất) rồi `9007199254740992` | Giá trị sau bị `422` (không phải số nguyên an toàn); ghi lại phản hồi thực tế của giá trị đầu | P3 | R |
| ADJ-013 | Tiền khớp sổ cái | Sau ADJ-001/002 | Cộng mọi entry của ví so với `balance` | Bằng nhau | P1 | S |

### 2.4 Đảo giao dịch (reversal)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| REV-001 | **Đảo một `ADJUSTMENT`** | Sau ADJ-001 (CREDIT 50000, có `transactionId`) và ví đủ tiền để đảo | `POST /ops/transactions/<transactionId>/reversals $H -d '{"reason":"qa reverse","idempotencyKey":"qa-rev-001"}'` | `201`; `{"transactionId":"tx_...","reversesTransactionId":"<gốc>","actionId":"..."}`; số dư quay về trước CREDIT; có entry đối nghịch với `businessKey:"reversal:<id gốc>"`; **giao dịch gốc không bị sửa** | P1 | S |
| REV-002 | Mỗi giao dịch chỉ bị đảo một lần | Sau REV-001 | Đảo lại cùng giao dịch, khóa mới | `409`, `ALREADY_REVERSED` | P1 | R |
| REV-003 | Idempotent: gửi lại cùng khóa | Sau REV-001 | Gửi lại đúng REV-001 | `201`, cùng `transactionId`/`actionId`, số dư không đổi | P1 | R |
| REV-004 | Đảo khoản trả order | Order đã trả ([`order-payment.md`](order-payment.md), ORD-001) | Lấy `walletTransactionId` từ `OrderPaidV1`; đảo | `201`; ví được hoàn lại; **không** có sự kiện hoàn tiền nào ra broker (wallet không phát) | P1 | R |
| REV-005 | Order bị đảo thì gửi lại bị `CONFLICT` | Sau REV-004 | Publish lại `OrderReadyForPaymentV1` cùng `orderId` (eventId mới) | `OrderPaymentFailedV1` `CONFLICT`; ví không bị trừ; log cảnh báo "order payment was reversed; refusing re-delivered order" | P1 | R |
| REV-006 | Không đảo được `TOPUP` | Có giao dịch nạp ([`wallet.md`](wallet.md)) | Đảo `transactionId` của topup | `409`, `REVERSAL_NOT_SUPPORTED` | P1 | R |
| REV-007 | Không đảo được `REVERSAL` | Sau REV-001 | Đảo `transactionId` của giao dịch đảo | `409`, `REVERSAL_NOT_SUPPORTED` | P1 | R |
| REV-008 | Giao dịch không tồn tại | — | `.../transactions/tx_doesnotexist/reversals` | `404`, `TRANSACTION_NOT_FOUND` | P1 | R |
| REV-009 | Đảo `ADJUSTMENT CREDIT` khi ví đã tiêu hết | ADJ CREDIT 50000 rồi tiêu hết (DEBIT hoặc order) | Đảo CREDIT | `409`, `INSUFFICIENT_FUNDS` (ví không đủ); không ghi gì | P1 | R |
| REV-011 | Đảo chạy được trên ví đóng băng | Ví đóng băng, có giao dịch đảo được | Đảo | `201` | P3 | R |
| REV-012 | Hai yêu cầu đảo đồng thời **khác khóa** | Một giao dịch | Bắn 2-5 `POST reversals` song song, mỗi cái khóa riêng | Đúng **một** `201`; còn lại `409 ALREADY_REVERSED`; số dư chỉ đổi một lần | P1 | R |

### 2.5 Phát lại `OrderPaidV1`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RPL-001 | **Phát lại sự kiện đã trả** | Order đã trả (ORD-001); queue `ecommerce.qa-results` ([`order-payment.md`](order-payment.md)) | `POST /ops/orders/<orderId>/replay-paid $H -d '{"reason":"qa replay","idempotencyKey":"qa-rpl-001"}'` | `202`; `{"eventId":"<eventId gốc>","actionId":"..."}`; message `order-paid.v1` mới trong queue với **cùng `eventId` và `occurredAtUtc`/`paidAtUtc` gốc**, `correlationId:"ops-replay:<actionId>"`; **số dư không đổi**, không có entry mới | P1 | S |
| RPL-002 | Order chưa trả | — | replay cho UUID lạ | `404`, `ORDER_NOT_FOUND` | P1 | R |
| RPL-003 | Order đã bị đảo | Sau REV-004 | replay | `409`, `ORDER_REVERSED`; không có message ra broker | P1 | R |
| RPL-004 | Idempotent theo khóa | Sau RPL-001 | Gửi lại đúng RPL-001 | `202`, cùng `eventId`/`actionId`; **không** thêm message mới trong queue | P1 | R |
| RPL-006 | `messageId` AMQP mới, `eventId` giữ nguyên | Sau RPL-001 | Trong management xem message: thuộc tính `message_id` và payload `eventId` | `message_id` **khác** `eventId` (là id outbox mới), payload `eventId` bằng `eventId` gốc | P2 | R |

### 2.6 Nhật ký `ops_actions`

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| LOG-001 | Xem nhật ký | Đã chạy một số case trên | `curl -s "$W/ops/actions?limit=20" $H` | `200`; `{"items":[{"id","action","actor","reason","target","createdAt"}],"nextCursor":...}`; **mới nhất trước**; **không** có `idempotencyKey`, `fingerprint`, `result` | P1 | S |
| LOG-002 | Mỗi thao tác đổi trạng thái có đúng một dòng | Trước/sau các thao tác đã làm | Đếm dòng theo `target` (`wallet:ops-c001`, `transaction:<id>`, `order:<id>`) | Số dòng khớp số thao tác đổi trạng thái: FRZ-001 (1), FRZ-004 (1), no-op (0), thao tác lỗi (0), replay cùng khóa (0) | P1 | R |
| LOG-003 | Loại thao tác | Sau các thao tác | Xem `action` | Thuộc `FREEZE`, `UNFREEZE`, `ADJUST`, `REVERSE`, `REPLAY_PAID` | P2 | R |
| LOG-004 | Phân trang | ≥ 3 dòng | `limit=1`, rồi dùng `nextCursor` | Mỗi trang 1 dòng, thứ tự giảm dần theo `seq`, trang cuối `nextCursor:null` | P2 | R |
| LOG-005 | `limit`/`cursor` sai | — | `limit=0`, `201`, `abc`; `cursor=abc`, `cursor=0`; lặp `?limit=1&limit=2` | `400`, `INVALID_QUERY` (`limit` 1..200) | P2 | R |
| LOG-006 | Nhật ký cách ly theo tenant | Có thao tác ở `acme` | `GET /ops/actions` với `x-tenant-id:beta` | Không thấy dòng của `acme` | P1 | R |
| LOG-007 | Nhật ký chỉ thêm | Tùy chọn, cần quyền SQL ghi | `UPDATE`/`DELETE` thử trên `t_acme.ops_actions` | Lỗi `ops_actions is append-only` (trigger `trg_ops_actions_append_only`) | P3 | R |
| LOG-008 | Khóa idempotency cô lập theo tenant | Hai tenant | Cùng khóa và cùng tham số ở `acme` và `beta` | Hai thao tác độc lập, mỗi nơi một dòng nhật ký | P2 | R |

### 2.7 Đồng thời và chịu lỗi

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| CON-001 | Hai yêu cầu cùng khóa đồng thời được tuần tự hóa | Ví có sẵn | Bắn 5 `POST adjustments` song song, **cùng khóa và nội dung** (`for i in 1 2 3 4 5; do curl ... & done; wait`) | Số dư thay đổi **đúng một lần**; mọi phản hồi cùng `transactionId`/`actionId`; chỉ một dòng nhật ký | P1 | R |
| CON-002 | Freeze song song cùng khóa | Ví có sẵn | 5 `freeze` song song cùng khóa | Tất cả `200` cùng `actionId`, `changed:true` (kể cả bên đến sau); một dòng nhật ký | P1 | R |
| CON-003 | Đảo và replay cùng order song song | Order đã trả | Bắn `reversals` và `replay-paid` gần như cùng lúc (khóa riêng) | Hoặc replay trước rồi đảo, hoặc đảo trước thì replay `409 ORDER_REVERSED`; **không bao giờ** có `OrderPaidV1` được xếp hàng cho khoản đã đảo | P2 | R |
| CON-004 | Wallet dừng giữa chừng không để lại trạng thái dở | Được phép dừng wallet | Bắn một adjust rồi `stop wallet` ngay; `start`; gửi lại **cùng khóa** | Kết quả cuối cùng nhất quán: hoặc thao tác chưa xảy ra (số dư cũ, thực hiện lại bình thường) hoặc đã xảy ra đúng một lần (gửi lại trả kết quả cũ) | P2 | R |

## 3. Bộ Smoke đề xuất

`OPS-001`, `OPS-003`, `FRZ-001`, `FRZ-004`, `FRZ-011`, `ADJ-001`, `ADJ-004`, `ADJ-013`, `REV-001`, `RPL-001`, `LOG-001`.
