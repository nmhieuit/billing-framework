# Test case: Đối soát (reconciliation)

Mỗi ngày wallet đối soát ngày D-1 (UTC) cho từng tenant: toàn vẹn sổ cái nội bộ và Wallet ↔ Gateway (sao kê payment so với `topups`). Lượt chạy bất biến; chỉ "ca" (item) được đóng bằng ghi chú. Route đối soát **chỉ dành cho mạng vận hành** và chỉ cần `x-tenant-id` (không có `x-actor-*`): `resolvedBy` do người gọi tự khai. Chuẩn bị môi trường xem [`moi-truong-va-du-lieu.md`](../moi-truong-va-du-lieu.md).

## 1. Chuẩn bị

```bash
W=http://localhost:3001
H='-H x-tenant-id:acme -H content-type:application/json'
TODAY=$(date -u +%F)
```

| Hạng mục | Giá trị |
| --- | --- |
| Endpoint | `POST /reconciliations`, `GET /reconciliations/{runId}`, `GET /reconciliations/{runId}/items`, `POST /reconciliation-items/{id}/resolve` |
| Ngày đối soát | `YYYY-MM-DD` (UTC), đúng lịch, **không ở tương lai** |
| Mã lỗi | `422 INVALID_RECONCILIATION`, `404 RECONCILIATION_NOT_FOUND`/`RECONCILIATION_ITEM_NOT_FOUND`, `409 RECONCILIATION_CONFLICT`, `400 INVALID_QUERY` |
| Tự ghi bù | `RECONCILE_AUTOFIX=true` (mặc định) |
| Giới hạn | `RECONCILE_MAX_ITEMS=50000`, `RECONCILE_MAX_ATTEMPTS=3`, định kỳ sau 02:00 UTC |

**Hình dạng kết quả:**
- `POST /reconciliations` trả `202 {"runId":"...","status":"RUNNING"}`. Lượt chạy nền.
- `GET /reconciliations/{runId}` trả `id` (không phải `runId`), `day`, `status` (`RUNNING`/`COMPLETED`/`FAILED`), `triggeredBy` (`MANUAL`), `failureReason`, `gatewayTotals`, `walletTotals`, `itemCount`, `startedAt`, `finishedAt`.
- Item có `id`, `runId`, `kind`, `chargeId`, `topupId`, `amountGateway`, `amountWallet`, `currency`, `detail`, `action`, `caseStatus` (`OPEN`/`RESOLVED`/`IGNORED`), `resolvedBy`, `resolutionNote`, `resolvedAt`, `createdAt`.
- Danh sách items: `caseStatus` ∈ `OPEN|RESOLVED|IGNORED`, `limit` 1..500 mặc định 100, `cursor`.

**Hàm trợ giúp chờ lượt xong:**

```bash
run() { curl -s -X POST $W/reconciliations $H -d "{\"date\":\"$1\"}"; }          # in {"runId":...}
wait_run() { for i in $(seq 1 30); do s=$(curl -s $W/reconciliations/$1 $H); echo "$s" | grep -q '"status":"RUNNING"' || { echo "$s"; return; }; sleep 2; done; }
```

> **Cảnh báo ảnh hưởng chéo (quan trọng):** đối soát đọc **toàn bộ sao kê payment của ngày** theo `metadata.tenantId` rồi so với `topups`. Các test ở [`wallet.md`](wallet.md), [`payment-simulator.md`](payment-simulator.md), [`order-payment.md`](order-payment.md) đã tạo dữ liệu hôm nay: charge gửi thẳng vào payment kèm `metadata.tenantId` mà **không** có topup tương ứng (PAY-040...), hoặc webhook ký tay làm ví thay đổi, sẽ sinh ca lệch (`UNKNOWN_CHARGE`, `MISSING_AT_GATEWAY`...). Vì vậy: chạy **REC-001 (lượt sạch) trước** các recipe tạo lệch ở mục 2.3; hoặc dùng tenant riêng (nếu `LOCAL_TENANTS` được mở rộng) để cách ly dữ liệu. Kết quả lượt ở một ngày **giữ nguyên** (bất biến), nên mỗi lần chạy là một lượt mới.
>
> Charge không có `metadata.tenantId` (hoặc của tenant khác) bị bỏ qua, không báo ở tenant nào.

## 2. Danh sách test case

Loại: **S** = Smoke, **R** = Regression. Ưu tiên: **P1** cao nhất, **P2**, **P3**.

### 2.1 Chạy đối soát

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| REC-001 | **Lượt sạch hôm nay** | Chưa tạo dữ liệu gây lệch (mục 1 cảnh báo); đã có vài topup `SUCCEEDED` hôm nay ([`wallet.md`](wallet.md)) | `R=$(run $TODAY); echo $R`; lấy `runId`; `wait_run <runId>` | `202` `{"runId":"...","status":"RUNNING"}`; sau vài giây `status:"COMPLETED"`, `triggeredBy:"MANUAL"`, `failureReason:null`, `finishedAt` có giá trị; `itemCount` **0** (có thể khác 0 nếu còn dữ liệu lẻ từ test khác) | P1 | S |
| REC-002 | Xem lượt theo `runId` | Sau REC-001 | `curl -s $W/reconciliations/<runId> $H` | `200`, các trường như mục 1; `day` = `$TODAY` | P1 | S |
| REC-003 | Liệt kê ca của lượt sạch | Sau REC-001 | `curl -s "$W/reconciliations/<runId>/items" $H` | `200`, danh sách rỗng (nếu `itemCount` 0) | P2 | S |
| REC-004 | Chạy lại cùng ngày tạo lượt **mới** | Sau REC-001 | Chạy lại `POST` cùng `date` | `runId` **khác**; lượt cũ vẫn nguyên (bất biến) | P1 | R |
| REC-005 | Tổng kiểm | Sau REC-001, có topup `SUCCEEDED` | Xem `gatewayTotals` và `walletTotals` | Có số theo đồng tiền; chỉ mang tính tham khảo (có thể lệch biên ngày); chỉ item mới là lệch thật | P3 | R |
| REC-006 | Ngày quá khứ không có dữ liệu | — | Chạy `date=2000-01-01` | Lượt `COMPLETED`, `itemCount` 0; ghi lại kết quả thực tế | P3 | R |

### 2.2 Validation và lỗi API

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| REC-010 | Thiếu tenant | — | `POST /reconciliations` không `x-tenant-id` | `400`, `MISSING_TENANT` | P1 | R |
| REC-011 | Tenant lạ | — | `x-tenant-id: zzz` | `403`, `UNKNOWN_TENANT` | P1 | R |
| REC-012 | Ngày sai định dạng | — | `date`: `2026/10/13`; `13-10-2026`; thiếu; `null` | `422`, `INVALID_RECONCILIATION` ("date must be formatted as YYYY-MM-DD") | P1 | R |
| REC-013 | Ngày không phải ngày lịch | — | `2026-02-30`; `2026-13-01` | `422`, `INVALID_RECONCILIATION` ("not a valid calendar date") | P2 | R |
| REC-014 | Ngày tương lai | — | `date` = ngày mai (UTC) | `422`, `INVALID_RECONCILIATION` ("must not be in the future") | P1 | R |
| REC-015 | Body không phải object | — | Body `[]`, `"x"` | `400`, `INVALID_REQUEST` | P3 | R |
| REC-016 | Lượt không tồn tại | — | `GET /reconciliations/does-not-exist` | `404`, `RECONCILIATION_NOT_FOUND` | P2 | R |
| REC-017 | Cách ly tenant của lượt | Lượt của `acme` | `GET /reconciliations/<runId>` với `x-tenant-id: beta` | `404`, `RECONCILIATION_NOT_FOUND` | P1 | R |
| REC-018 | `caseStatus` sai | Có lượt | `.../items?caseStatus=DONE` | `400`, `INVALID_QUERY` | P2 | R |
| REC-019 | `limit` sai | Có lượt | `limit=0`, `501`, `abc`, `1.5` | `400`, `INVALID_QUERY` (`limit` 1..500) | P2 | R |
| REC-020 | Tham số lặp | Có lượt | `?limit=1&limit=2`; `?caseStatus=OPEN&caseStatus=OPEN` | `400`, `INVALID_QUERY` | P3 | R |
| REC-021 | Cursor sai | Có lượt | `cursor=abc` | `400`, `INVALID_QUERY` | P3 | R |
| REC-022 | Items của lượt không tồn tại | — | `GET /reconciliations/nope/items` | `404`, `RECONCILIATION_NOT_FOUND` | P3 | R |

### 2.3 Dựng và đọc các loại lệch (recipe)

Mỗi recipe tạo **một loại lệch**. Chạy **sau REC-001**, mỗi recipe ghi lại `itemId`/`runId` để dùng ở mục 2.4.

| ID | Loại lệch | Tiền điều kiện | Bước (recipe) | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| REC-030 | `UNKNOWN_CHARGE` | Payment khỏe | (1) Tạo charge trực tiếp ở payment kèm `"metadata":{"tenantId":"acme"}` và `reference:"qa-orphan-1"` (PAY-001); (2) chờ `SUCCEEDED`; (3) chạy đối soát hôm nay | Lượt `COMPLETED`; có item `kind:"UNKNOWN_CHARGE"`, `chargeId` = charge vừa tạo, `topupId:null`, `caseStatus:"OPEN"`, `action:"NONE"` (**không tự ghi sổ**); số dư mọi ví không đổi | P1 | R |
| REC-031 | `MISSING_AT_GATEWAY` | Ví đã tạo, `acme` | (1) `docker compose -f deploy/compose.local.yml --env-file deploy/.env stop payment`; (2) `POST /topups`: topup ở `REQUESTED` vì không gửi được sang payment; (3) ký tay webhook `charge.succeeded` với `reference` = `topupId`, `amount`/`currency` khớp topup, `chargeId:"qa-fake-ch-1"`, `metadata.tenantId:"acme"` (cách ký ở [`wallet.md`](wallet.md) mục 2.7); (4) `start payment`; (5) chạy đối soát hôm nay | Bước 3: `200 {"outcome":"APPLIED"}` và số dư tăng; bước 5: item `kind:"MISSING_AT_GATEWAY"`, `topupId` đúng, `caseStatus:"OPEN"`; payment không có charge `qa-fake-ch-1` | P1 | R |
| REC-032 | `MISSING_AT_WALLET` + autofix | Được phép dừng `wallet`; `RECONCILE_AUTOFIX=true` | (1) Tạo topup và **dừng wallet ngay sau khi nó chuyển `PENDING`** (nếu webhook đến trước khi dừng kịp thì topup đã `SUCCEEDED`, không có lệch; thử lại); (2) giữ wallet dừng > 756 s (tổng backoff webhook `1,5,30,120,600`) để payment bỏ cuộc (`FAILED`); (3) `start wallet`; (4) chạy đối soát hôm nay | Charge `SUCCEEDED` ở payment, topup chưa `SUCCEEDED` ở wallet; sau đối soát: item `MISSING_AT_WALLET` với `action:"AUTO_APPLIED"`, topup chuyển `SUCCEEDED`, số dư tăng đúng một lần, entry có `businessKey:"topup:<topupId>"` | P2 | R |
| REC-033 | Ghi bù chạy lại là an toàn | Sau REC-032 | Chạy đối soát hôm nay lần nữa | Không ghi bù lần hai: số dư **không đổi**; item `MISSING_AT_WALLET` không còn (topup đã khớp) | P1 | R |
| REC-034 | `MISSING_AT_WALLET` khi tắt autofix | Cần đổi `RECONCILE_AUTOFIX=false` và tạo lại container wallet | Như REC-032 nhưng autofix tắt | Item `action:"NONE"`, tiền **chưa** vào ví | P3 | R |
| REC-035 | Không dựng bằng tay | `AMOUNT_MISMATCH`, `STATUS_MISMATCH`, `LEDGER_UNBALANCED`, `BALANCE_MISMATCH` | Đề xuất **bỏ khỏi manual**, dựa vào test integration | — | P3 | R |
| REC-036 | Đọc `detail` của ca lệch | Sau REC-030/031 | `GET .../items?caseStatus=OPEN`, đọc `detail` | `detail` chứa thông tin đối chiếu (`MISSING_AT_GATEWAY` có `topupCreatedAt`, `topupCompletedAt`); đủ để quyết định hành động | P2 | R |

### 2.4 Đóng ca (resolve)

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| RES-001 | **Đóng ca `RESOLVED`** | Có ca `OPEN` (REC-030) | `curl -s -X POST $W/reconciliation-items/<itemId>/resolve $H -d '{"status":"RESOLVED","note":"qa: đã điều tra, ticket 1","resolvedBy":"qa.tester"}'` | `200`; item `caseStatus:"RESOLVED"`, `resolvedBy:"qa.tester"`, `resolutionNote`, `resolvedAt`; **số dư và sổ cái không đổi** (đóng ca không sửa sổ cái) | P1 | S |
| RES-002 | Đóng ca `IGNORED` | Có ca `OPEN` khác | `status:"IGNORED"` | `200`, `caseStatus:"IGNORED"` | P1 | R |
| RES-003 | Đóng lại cùng giá trị trả cùng kết quả | Sau RES-001 | Gửi lại đúng RES-001 | `200`, cùng nội dung (không đổi `resolvedAt`) | P1 | R |
| RES-004 | Đóng lại với giá trị khác bị từ chối | Sau RES-001 | Gửi `status:"IGNORED"` hoặc `note` khác | `409`, `RECONCILIATION_CONFLICT` | P1 | R |
| RES-005 | `status` sai | Có ca `OPEN` | `"status":"OPEN"`; `"DONE"`; thiếu | `422`, `INVALID_RECONCILIATION` ("status must be RESOLVED or IGNORED") | P1 | R |
| RES-006 | `note` rỗng/quá dài | Có ca `OPEN` | `note:""`; `note` 501 ký tự | `422`, `INVALID_RECONCILIATION` (1..500) | P1 | R |
| RES-007 | `resolvedBy` rỗng/quá dài | Có ca `OPEN` | `resolvedBy:""`; 65 ký tự | `422`, `INVALID_RECONCILIATION` (1..64) | P1 | R |
| RES-008 | Item không tồn tại | — | `POST /reconciliation-items/nope/resolve` | `404`, `RECONCILIATION_ITEM_NOT_FOUND` | P2 | R |
| RES-009 | Lọc ca theo `caseStatus` | Sau RES-001/002 | `?caseStatus=OPEN`, `RESOLVED`, `IGNORED` | Mỗi lọc chỉ trả ca đúng trạng thái | P2 | R |
| RES-010 | `resolvedBy` tự khai (rủi ro bảo mật) | Có ca `OPEN` | Đóng ca với `resolvedBy:"nguoi.khac"` không cần danh tính | `200`, ghi nguyên giá trị tự khai: **không có xác thực danh tính**; chỉ ghi nhận như quan sát/rủi ro cho gateway/network policy | P1 | R |
| RES-011 | Đóng ca đồng thời | Có ca `OPEN` | Gửi 5 yêu cầu `resolve` song song cùng nội dung | Mọi phản hồi `200` cùng kết quả; không lỗi; một lần ghi | P2 | R |
| RES-012 | Đóng ca đồng thời giá trị khác nhau | Có ca `OPEN` | Song song `RESOLVED` và `IGNORED` | Một thắng; bên kia `409 RECONCILIATION_CONFLICT` | P2 | R |

### 2.5 Phân trang và lượt lỗi

| ID | Mục tiêu | Tiền điều kiện | Bước | Kết quả mong đợi | Ưu tiên | Loại |
| --- | --- | --- | --- | --- | --- | --- |
| REC-040 | Phân trang items | Một lượt có ≥ 3 ca (chạy REC-030, REC-031, REC-032 trước rồi một lượt mới) | `?limit=1` rồi dùng `nextCursor` | Mỗi trang 1 ca; không trùng/khuyết; trang cuối `nextCursor:null` | P2 | R |
| REC-050 | **Lượt `FAILED` khi payment lỗi** | Được phép dừng `payment` | (1) `stop payment`; (2) chạy đối soát hôm nay; (3) `wait_run`; (4) `start payment` | Lượt `FAILED`, `failureReason` nêu payment lỗi/timeout; **không có item nào được lưu** (`itemCount` 0); lượt sau (payment lên) chạy bình thường | P1 | R |
| REC-051 | Cảnh báo `billing-reconciliation-failed-run` | Sau REC-050 | Kibana (`http://localhost:15601`) → Rules (tag `billing`), trong 30 phút | Rule `billing-reconciliation-failed-run` báo (có lượt `FAILED` mới trong cửa sổ 30 phút); hết sau cửa sổ | P1 | R |
| REC-052 | Cảnh báo ca mở (`stale-cases`) | Có ca `OPEN` | Chờ > 24 giờ (mặc định) rồi mở Kibana | Rule `billing-reconciliation-stale-cases` báo; đóng ca thì hết sau ≤ 30 phút | P3 | R |
| REC-053 | Lượt định kỳ 02:00 UTC | Stack chạy qua mốc 02:00 UTC | Sáng hôm sau: xem log `reconcile-daily`, `GET` lượt `triggeredBy` là `SCHEDULED` | Mỗi tenant có một lượt cho ngày hôm qua; nếu không, rule `billing-reconciliation-missed` (26 giờ) báo | P3 | R |
| REC-054 | Dashboard | Sau các lượt | Dashboard "Billing: vận hành": panel đối soát | Hiển thị lượt gần nhất của từng tenant | P3 | R |

## 3. Bộ Smoke đề xuất

`REC-001`, `REC-002`, `REC-004`, `REC-014`, `REC-030`, `RES-001`, `RES-003`, `RES-004`.
