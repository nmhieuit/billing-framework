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
  /** Cỡ pool của kết nối tải (db). Mức đồng thời của lượt đo KHÔNG được vượt giá trị này: xem ssertConcurrencyFitsPool. */
  poolMax: number;
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
  /** Cỡ pool của kết nối tải; mặc định 64 (mức đồng thời cao nhất mặc định của PERF_CONCURRENCY). Dựng dữ liệu dùng độ song song riêng, không phụ thuộc giá trị này. */
  poolMax?: number;
  /** Chỉ để test: ghi đè tên tenant (ví dụ tên sai để mô phỏng dựng dở). */
  tenantNames?: string[];
}

export const DEFAULT_POOL_MAX = 64;

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

  // Mỗi bước chỉ chạy một lần khi thành công (gán undefined sau khi xong); stop() lỗi thì lần gọi sau thử lại đúng phần
  // còn dang dở (ví dụ drop database hỏng), còn stop() thành công thì idempotent.
  const stop = (): Promise<void> => {
    stopPromise ??= (async () => {
      const errors: unknown[] = [];
      const step = async (fn: () => Promise<unknown>, done: () => void): Promise<void> => {
        try {
          await fn();
          done();
        } catch (error) {
          errors.push(error);
        }
      };
      const pendingDb = db;
      if (pendingDb) {
        await step(
          () => pendingDb.destroy(),
          () => (db = undefined),
        );
      }
      const pendingAdmin = admin;
      if (pendingAdmin) {
        await step(
          () => pendingAdmin.destroy(),
          () => (admin = undefined),
        );
      }
      const pendingTest = testDb;
      if (pendingTest) {
        await step(
          () => pendingTest.drop(),
          () => (testDb = undefined),
        );
      }
      if (errors.length > 0) {
        stopPromise = undefined; // cho phép thử lại
        throw new AggregateError(errors, 'dọn môi trường đo có lỗi');
      }
    })();
    return stopPromise;
  };
  try {
    testDb = await createTestDatabase('perf_env');
    const names =
      options.tenantNames ?? Array.from({ length: options.tenants }, (_, i) => `perf${i + 1}`);
    const tenants = names.map((name) => TenantId.parse(name));
    const poolMax = options.poolMax ?? DEFAULT_POOL_MAX;
    db = createDatabase<WalletDatabase>({ ...testDb.config, poolMax });
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
      poolMax,
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

/**
 * Mức đồng thời của lượt đo không được vượt cỡ pool: worker thừa sẽ xếp hàng ở hàng đợi phía client của pool, DB không
 * bao giờ thấy quá `poolMax` transaction đồng thời, mức đó trùng mức `poolMax` và thời gian chờ pool bị tính vào độ trễ.
 * Runner của Task 5 gọi hàm này cho từng mức trước khi đo; mức vượt `poolMax` là KHÔNG HỢP LỆ.
 */
export function assertConcurrencyFitsPool(
  env: Pick<PerfEnv, 'poolMax'>,
  concurrency: number,
): void {
  if (concurrency > env.poolMax) {
    throw new Error(
      `concurrency ${concurrency} vượt poolMax ${env.poolMax}: tăng poolMax của createPerfEnv hoặc bỏ mức này (đo sẽ sai)`,
    );
  }
}
