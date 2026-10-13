import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrng } from './support/prng.js';
import {
  planFaults,
  planWorkerOps,
  runSoakRound,
  runSoakRounds,
  settleAndJudge,
  SOAK_WORKERS,
} from './support/soak.js';
import { createSystem, type System } from './support/system-harness.js';

/**
 * Phần SOAK nằm trong `test:chaos`: meta-test của bộ máy soak và MỘT vòng ngắn (inproc, ~15 giây) với seed CỐ ĐỊNH mặc
 * định (CHAOS_SEED nếu đặt) để chạy thường xuyên và tái hiện được. Bài soak dài, ngẫu nhiên (3 vòng x 30 giây, trộn
 * inproc/child) nằm ở `corepack pnpm test:chaos:soak` (soak-long.soak.test.ts) để `test:chaos` còn dư thời gian.
 * Xem soak.ts về mức độ tái hiện: cùng seed ⇒ cùng KẾ HOẠCH tải/lỗi, không đảm bảo cùng đan xen thực thi.
 */

const OUT_DIR = join(import.meta.dirname, '.out');
const DEFAULT_SEED = 1;

describe('soak: machinery and short fixed-seed round', () => {
  let current: System | undefined;
  afterEach(async () => {
    await current?.stop();
    current = undefined;
  });

  it('keeps every invariant in one short fixed-seed round (inproc)', async () => {
    const raw = process.env.CHAOS_SEED;
    const seed = raw === undefined || raw === '' ? DEFAULT_SEED : Number(raw);
    console.info(`chaos seed=${seed} rounds=1 mode=inproc`);
    await runSoakRounds({
      seed,
      rounds: 1,
      maxSeconds: 15,
      mode: 'inproc',
      outDir: OUT_DIR,
      rerun: () => `CHAOS_SEED=${seed} corepack pnpm test:chaos soak`,
      onSystem: (s) => {
        current = s;
      },
    });
  }, 900_000);

  it('meta: the machinery runs end to end and the same seed gives the same planned schedule', async () => {
    const SEED = 20_261_012;
    const DURATION_MS = 3_000;
    // Kế hoạch là hàm thuần của seed: hai lần cho cùng kết quả, seed khác cho kết quả khác.
    const plan = (seed: number) => ({
      faults: planFaults(createPrng(seed).fork('round-1'), 60_000, 'inproc'),
      ops: Array.from({ length: SOAK_WORKERS }, (_, w) =>
        planWorkerOps(createPrng(seed).fork('round-1'), w, 50),
      ),
    });
    expect(plan(SEED)).toEqual(plan(SEED));
    expect(plan(SEED)).not.toEqual(plan(SEED + 1));
    expect(plan(SEED).faults.length).toBeGreaterThan(3);

    const system = await createSystem({ seed: SEED, tenants: ['acme', 'beta'] });
    current = system;
    const prng = createPrng(SEED).fork('round-1');
    const report = await runSoakRound({ system, prng, durationMs: DURATION_MS, mode: 'inproc' });

    // Chạy thật: có tải và có lỗi bắn ra (lịch lỗi rỗng sẽ làm khẳng định này thất bại).
    expect(report.executed.length).toBeGreaterThan(0);
    expect(report.opsStarted.every((n) => n > 0)).toBe(true);
    // Thực thi khớp kế hoạch: lỗi đã thi hành là TIỀN TỐ của lịch lỗi, thao tác của mỗi luồng là TIỀN TỐ chuỗi chọn của luồng đó.
    expect(report.executed).toEqual(report.planned.slice(0, report.executed.length));
    expect(report.planned).toEqual(
      planFaults(createPrng(SEED).fork('round-1'), DURATION_MS, 'inproc'),
    );
    const entries = system.log.entries();
    for (let w = 0; w < SOAK_WORKERS; w += 1) {
      const ran = entries
        .filter((e) => e.kind === 'soak.op' && e.detail?.w === w)
        .map((e) => e.detail?.kind);
      const planned = planWorkerOps(createPrng(SEED).fork('round-1'), w, ran.length).map(
        (p) => p.kind,
      );
      expect(ran).toEqual(planned);
    }
    // Mọi lỗi và thao tác đều vào OpLog.
    expect(entries.filter((e) => e.kind === 'soak.fault')).toHaveLength(report.executed.length);

    await settleAndJudge(system, report);
  }, 600_000);
});
