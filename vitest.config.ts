import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['**/*.test.ts'],
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      'node-training/**',
      '**/*.integration.test.ts',
      '**/*.chaos.test.ts',
      '**/*.soak.test.ts',
      '**/*.perf.test.ts',
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['packages/*/src/**', 'services/*/src/**'],
      exclude: ['**/*.test.ts', '**/main.ts'],
    },
  },
});
