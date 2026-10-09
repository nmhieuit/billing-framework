import type { AppDependencies } from './app.js';

const unexpected = {
  execute: async (): Promise<never> => {
    throw new Error('unexpected call');
  },
};

/** Phụ thuộc giả cho test HTTP: use case nào không được test chủ động ghi đè sẽ ném lỗi khi bị gọi. */
export function stubDeps(overrides: Partial<AppDependencies> = {}): AppDependencies {
  return {
    createCharge: unexpected,
    getCharge: unexpected,
    getSettlement: unexpected,
    responseTimeoutMs: 20,
    ...overrides,
  };
}
