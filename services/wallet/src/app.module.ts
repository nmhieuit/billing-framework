import {
  type DynamicModule,
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import type { ApplyPaymentResult } from './application/apply-payment-result.js';
import type { CreateWallet } from './application/create-wallet.js';
import type { GetReconciliationRun } from './application/get-reconciliation-run.js';
import type { GetTopup } from './application/get-topup.js';
import type { GetWallet } from './application/get-wallet.js';
import type { ListEntries } from './application/list-entries.js';
import type { ListReconciliationItems } from './application/list-reconciliation-items.js';
import type { Clock, Logger, TenantRegistry } from './application/ports.js';
import type { RequestTopup } from './application/request-topup.js';
import type { ResolveReconciliationItem } from './application/resolve-reconciliation-item.js';
import type { StartManualReconciliation } from './application/start-manual-reconciliation.js';
import { CorrelationMiddleware } from './interface/http/correlation.middleware.js';
import { AllExceptionsFilter } from './interface/http/errors.js';
import { HealthController } from './interface/http/health.controller.js';
import { ReconciliationsController } from './interface/http/reconciliations.controller.js';
import {
  APPLY_PAYMENT_RESULT,
  CLOCK,
  CREATE_WALLET,
  GET_RECONCILIATION_RUN,
  GET_TOPUP,
  GET_WALLET,
  LIST_ENTRIES,
  LIST_RECONCILIATION_ITEMS,
  LOGGER,
  REQUEST_TOPUP,
  RESOLVE_RECONCILIATION_ITEM,
  START_RECONCILIATION,
  TENANT_REGISTRY,
  WEBHOOK_SECRET,
} from './interface/http/tokens.js';
import { TopupsController } from './interface/http/topups.controller.js';
import { WalletsController } from './interface/http/wallets.controller.js';
import { WebhooksController } from './interface/http/webhooks.controller.js';

export interface AppDeps {
  registry: TenantRegistry;
  clock: Clock;
  log: Logger;
  webhookSecret: string;
  createWallet: Pick<CreateWallet, 'execute'>;
  getWallet: Pick<GetWallet, 'execute'>;
  listEntries: Pick<ListEntries, 'execute'>;
  requestTopup: Pick<RequestTopup, 'execute'>;
  getTopup: Pick<GetTopup, 'execute'>;
  applyPaymentResult: Pick<ApplyPaymentResult, 'execute'>;
  startReconciliation: Pick<StartManualReconciliation, 'execute'>;
  getReconciliationRun: Pick<GetReconciliationRun, 'execute'>;
  listReconciliationItems: Pick<ListReconciliationItems, 'execute'>;
  resolveReconciliationItem: Pick<ResolveReconciliationItem, 'execute'>;
}

@Module({})
export class AppModule implements NestModule {
  /** Nối các use case đã dựng sẵn vào Nest bằng token tường minh (không dựa vào metadata kiểu). */
  static register(deps: AppDeps): DynamicModule {
    return {
      module: AppModule,
      controllers: [
        HealthController,
        WalletsController,
        TopupsController,
        WebhooksController,
        ReconciliationsController,
      ],
      providers: [
        { provide: TENANT_REGISTRY, useValue: deps.registry },
        { provide: CLOCK, useValue: deps.clock },
        { provide: LOGGER, useValue: deps.log },
        { provide: WEBHOOK_SECRET, useValue: deps.webhookSecret },
        { provide: CREATE_WALLET, useValue: deps.createWallet },
        { provide: GET_WALLET, useValue: deps.getWallet },
        { provide: LIST_ENTRIES, useValue: deps.listEntries },
        { provide: REQUEST_TOPUP, useValue: deps.requestTopup },
        { provide: GET_TOPUP, useValue: deps.getTopup },
        { provide: APPLY_PAYMENT_RESULT, useValue: deps.applyPaymentResult },
        { provide: START_RECONCILIATION, useValue: deps.startReconciliation },
        { provide: GET_RECONCILIATION_RUN, useValue: deps.getReconciliationRun },
        { provide: LIST_RECONCILIATION_ITEMS, useValue: deps.listReconciliationItems },
        { provide: RESOLVE_RECONCILIATION_ITEM, useValue: deps.resolveReconciliationItem },
        { provide: APP_FILTER, useClass: AllExceptionsFilter },
      ],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
