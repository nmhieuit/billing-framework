# Coverage hiện tại của dự án

Tài liệu này trả lời: test tự động của dev phủ bao nhiêu code, đo thế nào, và con số đó có ý nghĩa gì cho QA.

**Cách đọc nhãn bằng chứng:** **chạy thật** là kết quả lệnh đã chạy; **tính từ lcov** là số tính thêm từ hai báo cáo lcov của hai lần chạy; **cấu hình** là đọc từ file cấu hình.

## 1. Coverage này đo cái gì

Công cụ: `v8` của Vitest (`vitest.config.ts`).

| Hạng mục | Giá trị | Bằng chứng |
| --- | --- | --- |
| Phạm vi code được đo **trong CI** | `packages/*/src/**` và `services/*/src/**` | cấu hình |
| Bị loại khỏi phạm vi CI | `*.test.ts`, `main.ts`. **Không** nằm trong phạm vi CI: `db/`, `tools/`, `tests/` | cấu hình |
| Ngưỡng coverage | Không có (không thấy `thresholds` trong cấu hình) | cấu hình |
| Lệnh coverage trong CI (`Jenkinsfile`, stage Test) | `pnpm test:coverage`, chạy **chỉ bộ unit**; các bộ integration, chaos, soak, perf bị loại | cấu hình |
| SonarQube | Đọc `coverage/lcov.info` do lệnh trên sinh ra (`sonar-project.properties`) | cấu hình |

**Hệ quả:** con số coverage mà CI và SonarQube nhìn thấy chỉ là coverage của **bộ unit** trên `packages/*` và `services/*`. Bộ integration (cần Docker) chạy ở stage riêng và không được tính vào con số đó. Tài liệu này đo thêm hai phạm vi để QA thấy toàn cảnh, bằng tham số dòng lệnh (không sửa cấu hình của repo):

- **Phạm vi CI:** `packages/*/src/**` + `services/*/src/**` (3141 dòng, 174 file).
- **Phạm vi mở rộng:** phạm vi CI + `db/**` + `tools/**` (3907 dòng, 192 file). Lưu ý `tools/**` có cả file hỗ trợ test như `tools/kibana/fake-kibana.ts`.

## 2. Số liệu đo thật

Đo ngày 2026-10-15, trên máy này. Ghi báo cáo ra thư mục tạm ngoài repo.

| Lần chạy | Số file test | Số test | Kết quả |
| --- | --- | --- | --- |
| Unit (`vitest run --coverage`) | 99 | 1034 | Tất cả pass (chạy thật) |
| Integration (`vitest run --config vitest.integration.config.ts --coverage`) | 64 | 609 | Tất cả pass (chạy thật) |

### 2.1 Tổng, phạm vi mở rộng (có `db/` và `tools/`)

Số do Vitest in ra (chạy thật). Gộp là tính từ lcov: một dòng hoặc nhánh được tính là đã phủ nếu **ít nhất một** trong hai lần chạy chạm tới nó.

| Bộ test | Dòng | Nhánh | Hàm | Câu lệnh |
| --- | --- | --- | --- | --- |
| Chỉ unit | **55,77%** (2179/3907) | 51,59% (1196/2318) | 49,09% (540/1100) | 54,73% (2382/4352) |
| Chỉ integration | **68,18%** (2664/3907) | 59,57% (1381/2318) | 72,09% (793/1100) | 66,24% (2883/4352) |
| Gộp unit và integration (tính từ lcov) | **95,9%** (3746/3907) | 88,7% | — | — |

### 2.2 Tổng, phạm vi CI (chỉ `packages/*` và `services/*`)

| Bộ test | Dòng | Nhánh |
| --- | --- | --- |
| Chỉ unit (con số CI và SonarQube thấy) | **48,13%** (1512/3141) | 43,95% (810/1843) |
| Chỉ integration | **84,27%** (2647/3141) | 74,93% (1381/1843) |
| Gộp (tính từ lcov) | **97,7%** (3069/3141) | 90,7% |

### 2.3 Theo khu vực (phạm vi mở rộng; dòng và nhánh, tính từ lcov)

| Khu vực | Chỉ unit | Chỉ integration | Gộp |
| --- | --- | --- | --- |
| `services/wallet` | 34,0% dòng, 31,1% nhánh | 88,5% dòng, 81,1% nhánh | **97,6% dòng, 91,6% nhánh** |
| `services/payment` | 55,6% dòng, 57,1% nhánh | 78,9% dòng, 69,8% nhánh | **98,5% dòng, 95,0% nhánh** |
| `packages/contracts` | 100% dòng, 89,3% nhánh | 83,3% dòng, 80,4% nhánh | 100% dòng, 89,3% nhánh |
| `packages/database` | 76,9% dòng, 74,6% nhánh | 47,7% dòng, 45,1% nhánh | 100% dòng, 91,5% nhánh |
| `packages/messaging` | 78,0% dòng, 53,4% nhánh | 95,5% dòng, 77,4% nhánh | 97,6% dòng, 83,6% nhánh |
| `packages/money` | 100% dòng, 100% nhánh | 51,5% dòng, 31,8% nhánh | 100% dòng, 100% nhánh |
| `packages/observability` | 98,2% dòng, 75,0% nhánh | 24,6% dòng, 25,0% nhánh | 98,2% dòng, 78,6% nhánh |
| `packages/runtime` | 100% dòng, 95,8% nhánh | 58,9% dòng, 62,5% nhánh | 100% dòng, 95,8% nhánh |
| `packages/testing` | 59,8% dòng, 38,2% nhánh | 89,8% dòng, 61,8% nhánh | 91,3% dòng, 63,6% nhánh |
| `db/` (6 file) | 2,5% dòng, 0% nhánh | 27,5% dòng, 0% nhánh | **27,5% dòng**, 0% nhánh |
| `tools/kibana` (11 file) | 96,2% dòng, 86,2% nhánh | 0% | **96,2% dòng, 86,2% nhánh** |
| `tools/local` (1 file: `seed.ts`) | 70,4% dòng, 63,2% nhánh | 0% | **70,4% dòng, 63,2% nhánh** |

**`db/`:** các file migration của payment (`001-init.ts`, `002-metadata.ts`, `003-retention-indexes.ts`, `migrations.ts`) được phủ 100% bởi test migration (integration). Hai script chạy migration bằng lệnh (`db/payment/migrate.ts` 0/11 dòng, `db/wallet/migrate.ts` 0/18 dòng) **không có test nào chạm tới**, nên kéo tỷ lệ của `db/` xuống. Migration của wallet nằm trong `services/wallet/src/infrastructure/kysely` và đã tính trong `services/wallet`.

**`tools/`:** các công cụ Kibana (dựng, áp dụng, kiểm quy tắc cảnh báo và dashboard) chỉ có unit test với một Kibana giả. Tỷ lệ cao cho biết code của công cụ được chạy, **không** cho biết cảnh báo hoạt động đúng trên Kibana thật.

### 2.4 Các file còn nhiều dòng chưa được chạm (gộp, phạm vi mở rộng)

Gộp hai bộ, còn 161 dòng chưa được chạm trên tổng 3907. Các file có tỷ lệ dòng thấp nhất (file từ 20 dòng trở lên, không kể hai script migrate của `db/` ở trên):

| File | Dòng đã phủ |
| --- | --- |
| `tools/local/seed.ts` | 70,4% (88/125) |
| `services/wallet/src/application/reverse-transaction.ts` | 86,2% (25/29) |
| `services/wallet/src/bootstrap.ts` | 89,7% (87/97) |
| `services/wallet/src/infrastructure/kysely/ops.repository.ts` | 90,0% (18/20) |
| `tools/kibana/cli.ts` | 90,4% (75/83) |
| `services/payment/src/bootstrap.ts` | 90,6% (29/32) |
| `tools/kibana/verify.ts` | 92,0% (80/87) |

## 3. Cách đọc các con số (quan trọng cho QA)

1. **Coverage là "dòng code có được chạy khi test", không phải "hành vi đã được kiểm đúng".** Một dòng được chạy mà test không có kỳ vọng đúng vẫn tính là đã phủ. Đừng kết luận "đã test kỹ" chỉ từ con số cao, cũng đừng kết luận "thiếu test" chỉ từ con số thấp. Cách kiểm đúng là đọc hành vi cụ thể ở [`ma-tran-phu.md`](ma-tran-phu.md).
2. **Số 48% mà CI báo không phản ánh toàn bộ test của dev.** Nó chỉ đếm bộ unit. Gộp thêm bộ integration, các dòng được chạm lên khoảng 98% (mục 2.2). Phần lớn logic nghiệp vụ của wallet nằm ở use case và repository, được kiểm bằng integration với DB thật nên unit đơn lẻ chỉ chạm 34%.
3. **Coverage theo cấu hình CI chỉ tính `packages/*/src` và `services/*/src`.** `db/` và `tools/` có test nhưng không có con số trong CI; bảng 2.1 và 2.3 đo thêm hai thư mục này. `tests/` (chaos, perf, e2e) là code của test nên không đo.
4. **Coverage không nói gì về stack đã deploy.** Các test này chạy trong process của test, không chạy vào `billing-local`. Phần lớn công việc manual của QA nằm ở đó (xem [`tranh-manual-lap.md`](tranh-manual-lap.md)).
5. **Chaos, soak và perf** (xem [`loai-test.md`](loai-test.md)) không được tính vào hai lần đo trên. Chúng chạy bằng lệnh riêng và không nằm trong CI.

## 4. Cách tự đo lại

```bash
# Unit, phạm vi mở rộng (có db và tools). Bỏ các thư mục worktree khác nếu có
corepack pnpm vitest run --exclude='**/.claude/**' --coverage.enabled=true --coverage.provider=v8 \
  --coverage.include='packages/*/src/**' --coverage.include='services/*/src/**' \
  --coverage.include='db/**' --coverage.include='tools/**' \
  --coverage.exclude='**/*.test.ts' --coverage.exclude='**/main.ts'

# Integration, phạm vi mở rộng (cần Docker đang chạy; mất khoảng 10 phút trên máy này)
corepack pnpm vitest run --config vitest.integration.config.ts --exclude='**/.claude/**' \
  --coverage.enabled=true --coverage.provider=v8 \
  --coverage.include='packages/*/src/**' --coverage.include='services/*/src/**' \
  --coverage.include='db/**' --coverage.include='tools/**' \
  --coverage.exclude='**/*.test.ts' --coverage.exclude='**/main.ts'
```

Để đo đúng như CI, dùng `corepack pnpm test:coverage`.

Ghi chú:
- Lệnh coverage mặc định ghi vào thư mục `coverage/` ở gốc repo (đã bị gitignore) và thay nội dung cũ của thư mục đó. Dùng `--coverage.reportsDirectory=<đường dẫn khác>` nếu cần giữ báo cáo cũ.
- Khi máy đang chạy nhiều container (ví dụ Vitest trong IDE hoặc một lượt test khác), container SQL Server có thể khởi động chậm quá 120 giây và lượt integration báo lỗi `Recovery is complete not received`. Chạy lại khi máy rảnh.
- Nếu repo có thư mục worktree khác dưới `.claude/worktrees`, lệnh `vitest` mặc định sẽ tìm cả test trong đó và đếm gấp đôi; dùng `--exclude` như trên.
