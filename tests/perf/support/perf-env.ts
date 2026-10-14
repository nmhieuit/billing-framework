import { createDatabase } from '@billing/database';
import { createTestDatabase, type TestDatabase } from '@billing/testing';
import type { Kysely } from 'kysely';
import { AdjustWallet } from '../../../services/wallet/src/application/adjust-wallet.js';
import { ApplyPaymentResult } from '../../../services/wallet/src/application/apply-payment-result.js';
import { CreateWallet } from '../../../services/wallet/src/application/create-wallet.js';
import { OpsActionRecorder } from '../../../services/wallet/src/application/ops-recorder.js';
import { PayOrder } from '../../../services/wallet/src/application/pay-order.js';
import {
  noopMetrics,
  type Clock,
  type IdGenerator,
  type Logger,
} from '../../../services/wallet/src/application/ports.js';
import { ReverseTransaction } from '../../../services/wallet/src/application/reverse-transaction.js';
import { TenantId } from '../../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../../services/wallet/src/infrastructure/kysely/provisioning.js';
import type { WalletDatabase } from '../../../services/wallet/src/infrastructure/kysely/schema.js';
import { KyselyTenantUnitOfWork } from '../../../services/wallet/src/infrastructure/kysely/unit-of-work.js';
import {
  RandomIdGenerator,
  SystemClock,
} from '../../../services/wallet/src/infrastructure/system.js';

export interface PerfEnv {
  tenants: TenantId[];
  /** Kết nối của tải đo (pool `poolMax`); mọi use case chạy qua đây. */
  db: Kysely<WalletDatabase>;
  /** Kết nối quản trị riêng (pool nhỏ, không tranh chỗ với tải): dùng để dựng/kiểm tra/làm hỏng trạng thái. */
  admin: Kysely<unknown>;
  databaseName: string;
  uow: KyselyTenantUnitOfWork;
  /** Đồng hồ và bộ sinh id THẬT (dùng chung cho mọi use case của môi trường). */
  clock: Clock;
  ids: IdGenerator;
  payOrder: PayOrder;
  applyPayment: ApplyPaymentResult;
  reverse: ReverseTransaction;
  adjust: AdjustWallet;
  createWallet: CreateWallet;
  /** Idempotent; luôn cố dọn hết (đóng kết nối, drop database) rồi mới ném lỗi gộp (nếu có). */
  stop(): Promise<void>;
}

export interface PerfEnvOptions {
  /** Số tenant, đặt tên `perf1..perfN`. Phase A dùng 1 (một MERCHANT nóng duy nhất trên mỗi (tenant, đồng tiền)). */
  tenants: number;
  /** Cỡ pool của kết nối tải; mặc định 16 (đủ cho tải đồng thời của lúc dựng dữ liệu). */
  poolMax?: number;
  /** Chỉ để test: ghi đè tên tenant (ví dụ tên sai để mô phỏng dựng dở). */
  tenantNames?: string[];
}

const silentLogger: Logger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Dựng môi trường đo MỨC USE CASE: một database riêng đã cấp phát tenant, use case thật của wallet nối với đồng hồ thật,
 * RandomIdGenerator, metrics noop và logger im lặng (không dùng FakeClock/SequentialIds như test thường).
 * Tài nguyên được gán dần; dựng hỏng giữa chừng thì dọn phần đã dựng rồi ném lại lỗi gốc.
 */
export async function createPerfEnv(options: PerfEnvOptions): Promise<PerfEnv> {
  let testDb: TestDatabase | undefined;
  let db: Kysely<WalletDatabase> | undefined;
  let admin: Kysely<unknown> | undefined;
  let stopPromise: Promise<void> | undefined;

  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const errors: unknown[] = [];
      const step = async (fn: (() => Promise<unknown>) | undefined): Promise<void> => {
        if (fn === undefined) return;
        try {
          await fn();
        } catch (error) {
          errors.push(error);
        }
      };
      await step(() => db?.destroy() ?? Promise.resolve());
      await step(() => admin?.destroy() ?? Promise.resolve());
      await step(() => testDb?.drop() ?? Promise.resolve());
      if (errors.length > 0) throw new AggregateError(errors, 'dọn môi trường đo có lỗi');
    })();
    return stopPromise;
  };

  try {
    testDb = await createTestDatabase('perf_env');
    const names =
      options.tenantNames ?? Array.from({ length: options.tenants }, (_, i) => `perf${i + 1}`);
    const tenants = names.map((name) => TenantId.parse(name));
    db = createDatabase<WalletDatabase>({ ...testDb.config, poolMax: options.poolMax ?? 16 });
    admin = createDatabase<unknown>({ ...testDb.config, poolMax: 2 });
    await provisionTenants(admin, tenants);

    const uow = new KyselyTenantUnitOfWork(db);
    const clock = new SystemClock();
    const ids = new RandomIdGenerator();
    const recorder = new OpsActionRecorder({
      uow,
      clock,
      ids,
      log: silentLogger,
      metrics: noopMetrics,
    });
    return {
      tenants,
      db,
      admin,
      databaseName: testDb.config.database,
      uow,
      clock,
      ids,
      payOrder: new PayOrder({ uow, clock, ids, log: silentLogger }),
      applyPayment: new ApplyPaymentResult({
        uow,
        clock,
        ids,
        log: silentLogger,
        metrics: noopMetrics,
      }),
      reverse: new ReverseTransaction({ recorder, ids }),
      adjust: new AdjustWallet({ recorder, ids }),
      createWallet: new CreateWallet({ uow, clock }),
      stop,
    };
  } catch (error) {
    // Lỗi dọn không được che lỗi gốc.
    await stop().catch(() => undefined);
    throw error;
  }
}
