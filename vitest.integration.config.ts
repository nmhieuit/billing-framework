import { defineConfig } from 'vitest/config';

// Chạy các test cần Docker (SQL Server qua testcontainers). Một container dùng chung cho cả lượt chạy.
export default defineConfig({
  test: {
    include: ['**/*.integration.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./packages/testing/src/containers.global-setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
