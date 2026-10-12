import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrng, resolveSeed } from './support/prng.js';
import {
  planFaults,
  planWorkerOps,
  runSoakRound,
  settleAndJudge,
  SOAK_WORKERS,
} from './support/soak.js';
import { createSystem, type System } from './support/system-harness.js';

/**
 * Bài SOAK: tải ngẫu nhiên có seed + lỗi ngẫu nhiên có seed, oracle quyết định sau heal.
 *
 * Biến môi trường: CHAOS_SEED (mặc định ngẫu nhiên), CHAOS_ROUNDS (3), CHAOS_MAX_SECONDS (30, mỗi vòng),
 * CHAOS_MODE = inproc | child | mixed (mặc định mixed: vòng lẻ inproc, vòng chẵn child).
 * Xem soak.ts về mức độ tái hiện: cùng seed ⇒ cùng KẾ HOẠCH tải/lỗi, không đảm bảo cùng đan xen thực thi.
 */

const OUT_DIR = join(import.meta.dirname, '.out');
const MODES = ['inproc', 'child', 'mixed'] as const;
type SoakMode = (typeof MODES)[number];

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

const roundMode = (mode: SoakMode, round: number): 'inproc' | 'child' =>
  mode === 'mixed' ? (round % 2 === 1 ? 'inproc' : 'child') : mode;

describe('soak: seeded random load and faults', () => {
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

    for (let round = 1; round <= rounds; round += 1) {
      const kind = roundMode(mode, round);
      const prng = createPrng(seed).fork(`round-${round}`);
      // Retention THẬT trong ~1/3 số vòng inproc (rút prng ở mọi vòng nên ổn định theo seed). Child bị loại: loadConfig thật của
      // dịch vụ từ chối chu kỳ lẻ phút và số ngày < 7 cho khóa idempotency của payment, nên tiến trình con không chạy được cấu hình này.
      const wantsRetention = prng.fork('retention').chance(1 / 3);
      const realRetention = wantsRetention && kind === 'inproc';
      const startedAt = Date.now();
      let system: System | undefined;
      try {
        const options = {
          seed,
          tenants: ['acme', 'beta'],
          ...(realRetention
            ? {
                retention: {
                  dryRun: false,
                  batchSize: 5,
                  intervalMinutes: 0.1,
                  days: {
                    wallet: {
                      outboxSent: 1,
                      processedMessages: 1,
                      idempotencyKeys: 1,
                      reconciliation: 1,
                    },
                    payment: { webhook: 1, idempotencyKeys: 1 },
                  },
                },
              }
            : {}),
        };
        // Child: wallet có thể chết vài giây; lịch webhook dài như S9 để webhook không hết lượt chỉ vì thế.
        system =
          kind === 'child'
            ? await createSystem({
                ...options,
                mode: 'child',
                webhookBackoffSeconds: [2, 5, 10, 20, 30],
              })
            : await createSystem(options);
        current = system;
        const report = await runSoakRound({
          system,
          prng,
          durationMs: maxSeconds * 1000,
          mode: kind,
        });
        const verdict = await settleAndJudge(system, report);
        console.info(
          `chaos round=${round}/${rounds} mode=${kind} retention=${realRetention} missingAtWallet=${verdict.missingAtWallet} tolerated=${verdict.tolerated} faults=${report.executed.length}/${report.planned.length} ops=${report.opsStarted.reduce((a, b) => a + b, 0)} clientErrors=${report.opErrors} webhookAffecting=${report.webhookAffecting} ${Math.round((Date.now() - startedAt) / 1000)}s`,
        );
        expect(report.executed.length, 'lịch lỗi phải thực sự bắn lỗi').toBeGreaterThan(0);
        // Từng loại tải chính phải thực sự thành công ít nhất một lần (maxSeconds quá ngắn thì bỏ qua kiểm tra này).
        if (maxSeconds >= 20) {
          for (const op of ['topup', 'order', 'adjust', 'read', 'freeze'] as const) {
            expect(
              report.succeeded[op] ?? 0,
              `loại tải ${op} chưa từng thành công`,
            ).toBeGreaterThan(0);
          }
        }
      } catch (error) {
        // Ghi seed, vòng, nhật ký lỗi + thao tác rồi in lệnh chạy lại và ném lại.
        if (system !== undefined) {
          system.log.record('soak.failure', {
            seed,
            round,
            mode: kind,
            error: error instanceof Error ? error.message : String(error),
          });
          const path = await system.log.writeTo(OUT_DIR, `soak-${seed}-round${round}`);
          console.error(`[chaos] soak thất bại (seed=${seed}, vòng ${round}); nhật ký: ${path}`);
        }
        console.error(
          `[chaos] chạy lại: CHAOS_SEED=${seed} CHAOS_ROUNDS=${round} corepack pnpm test:chaos soak`,
        );
        throw error;
      } finally {
        await system?.stop();
        current = undefined;
      }
    }
  }, 3_600_000);

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
