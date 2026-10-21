import { defineConfig } from 'vitest/config';

// solutions/ và examples/ không chạy khi học (tránh lộ lời giải).
// Người biên soạn bật bằng NT_ALL=1 (xem scripts/verify.sh).
const hidden = process.env.NT_ALL ? [] : ['solutions/**', 'examples/**'];

export default defineConfig({
  test: {
    exclude: ['**/node_modules/**', ...hidden],
  },
});
