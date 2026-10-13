import { join } from 'node:path';
import { afterEach, describe, it } from 'vitest';
import { resolveSeed } from './support/prng.js';
import { runSoakRounds, type SoakMode } from './support/soak.js';
import type { System } from './support/system-harness.js';

/**
 * Bài SOAK DÀI, chạy riêng bằng `corepack pnpm test:chaos:soak` (cấu hình vitest.chaos-soak.config.ts, không nằm trong
 * `test:chaos`). Seed ngẫu nhiên trừ khi đặt CHAOS_SEED; dòng `chaos seed=<n> rounds=<m> mode=<mode>` luôn được in
 * (cấu hình vitest.chaos-soak.config.ts đặt `silent: false` vì vitest ẩn console của test đạt).
 *
 * Biến môi trường: CHAOS_SEED, CHAOS_ROUNDS (3), CHAOS_MAX_SECONDS (30, mỗi vòng),
 * CHAOS_MODE = inproc | child | mixed (mặc định mixed: vòng lẻ inproc, vòng chẵn child).
 * Khi thất bại: tests/chaos/.out/soak-<seed>-round<k>.json và lệnh chạy lại được in ra.
 */

const OUT_DIR = join(import.meta.dirname, '.out');
const MODES: readonly SoakMode[] = ['inproc', 'child', 'mixed'];

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} không hợp lệ: ${raw}`);
  return value;
}

function resolveMode(): SoakMode {
  const raw = process.env.CHAOS_MODE ?? 'mixed';
  if (!(MODES as readonly string[]).includes(raw)) {
    throw new Error(`CHAOS_MODE không hợp lệ: ${raw} (inproc | child | mixed)`);
  }
  return raw as SoakMode;
}

describe('soak (long, random)', () => {
  let current: System | undefined;
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it('keeps every invariant under random failures', async () => {
    const seed = resolveSeed(process.env);
    const rounds = envInt('CHAOS_ROUNDS', 3);
    const maxSeconds = envInt('CHAOS_MAX_SECONDS', 30);
    const mode = resolveMode();
    console.info(`chaos seed=${seed} rounds=${rounds} mode=${mode}`);
    await runSoakRounds({
      seed,
      rounds,
      maxSeconds,
      mode,
      outDir: OUT_DIR,
      rerun: (round) => `CHAOS_SEED=${seed} CHAOS_ROUNDS=${round} corepack pnpm test:chaos:soak`,
      onSystem: (s) => {
        current = s;
      },
    });
  }, 3_600_000);
});
