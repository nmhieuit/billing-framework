import { createDatabase } from '@billing/database';
import { createLogger } from '@billing/observability';
import { Worker, once, runAll } from '@billing/runtime';
import type { FastifyInstance } from 'fastify';
import { CompleteDueCharges } from './application/complete-due-charges.js';
import { CreateCharge } from './application/create-charge.js';
import { DeliverDueWebhooks } from './application/deliver-due-webhooks.js';
import { GetCharge } from './application/get-charge.js';
import { GetSettlement } from './application/get-settlement.js';
import type { Clock, IdGenerator } from './application/ports.js';
import type { PaymentConfig } from './config.js';
import { HttpWebhookSender } from './infrastructure/http-webhook-sender.js';
import type { PaymentDatabase } from './infrastructure/kysely/schema.js';
import { KyselyUnitOfWork } from './infrastructure/kysely/unit-of-work.js';
import { RandomIdGenerator, SystemClock } from './infrastructure/system.js';
import { buildApp } from './interface/http/app.js';

export interface StartOverrides {
  clock?: Clock;
  ids?: IdGenerator;
}

export interface RunningService {
  app: FastifyInstance;
  stop(): Promise<void>;
}

/** Composition root: nối mọi thứ lại, chạy worker nền; app chưa `listen` (main.ts hoặc test tự làm). */
export async function startService(
  config: PaymentConfig,
  overrides: StartOverrides = {},
): Promise<RunningService> {
  const log = createLogger('payment');
  const db = createDatabase<PaymentDatabase>(config.database);
  const clock = overrides.clock ?? new SystemClock();
  const ids = overrides.ids ?? new RandomIdGenerator();
  const uow = new KyselyUnitOfWork(db);
  const sender = new HttpWebhookSender({ url: config.webhook.url, secret: config.webhook.secret });

  const completeDue = new CompleteDueCharges({ uow, clock, ids });
  const deliver = new DeliverDueWebhooks({
    uow,
    sender,
    clock,
    backoffSeconds: config.webhook.backoffSeconds,
  });

  const app = await buildApp({
    createCharge: new CreateCharge({ uow, clock, ids }),
    getCharge: new GetCharge({ uow }),
    getSettlement: new GetSettlement({ uow, clock }),
    responseTimeoutMs: config.responseTimeoutMs,
    log,
  });

  const worker = new Worker({
    intervalMs: config.workerIntervalMs,
    tasks: [
      () => completeDue.execute(),
      (signal) => deliver.execute(undefined, { shouldContinue: () => !signal.aborted }),
    ],
    onError: (error) => log.error({ err: error }, 'worker task failed'),
  });
  worker.start();

  return {
    app,
    stop: once(() => runAll([() => worker.stop(), () => app.close(), () => db.destroy()])),
  };
}
