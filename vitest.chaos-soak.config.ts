import { defineConfig } from 'vitest/config';

// Bài soak dài (SQL Server + RabbitMQ qua testcontainers), chạy bằng `pnpm test:chaos:soak`. Không nằm trong test:chaos.
export default defineConfig({
  test: {
    include: ['tests/chaos/**/*.soak.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./packages/testing/src/containers.global-setup.ts'],
    testTimeout: 3_600_000,
    hookTimeout: 180_000,
    fileParallelism: false,
    silent: false,
  },
});
