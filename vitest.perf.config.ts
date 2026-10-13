import { defineConfig } from 'vitest/config';

// Chạy bộ đo hiệu năng (SQL Server qua testcontainers). Không nằm trong test/test:integration; tệp đặt tên *.perf.test.ts.
export default defineConfig({
  test: {
    include: ['tests/perf/**/*.perf.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./packages/testing/src/containers.global-setup.ts'],
    // Lượt đo kéo dài nhiều phút: timeout rất lớn, chạy tuần tự từng tệp, giữ nguyên đầu ra.
    testTimeout: 3_600_000,
    hookTimeout: 3_600_000,
    fileParallelism: false,
    silent: false,
  },
});
