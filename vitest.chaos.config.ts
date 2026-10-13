import { defineConfig } from 'vitest/config';

// Chạy các test chaos (SQL Server qua testcontainers). Không nằm trong test:integration; tệp đặt tên *.chaos.test.ts.
export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.chaos.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./packages/testing/src/containers.global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
