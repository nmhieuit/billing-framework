import Fastify, { type FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithCorrelation,
} from '@billing/observability';
import type { CreateCharge } from '../../application/create-charge.js';
import type { GetCharge } from '../../application/get-charge.js';
import type { GetSettlement } from '../../application/get-settlement.js';
import { chargesRoutes } from './charges.route.js';
import { registerErrorHandling, type ErrorLogger } from './errors.js';
import { healthRoute } from './health.route.js';
import { settlementsRoutes } from './settlements.route.js';

export interface AppDependencies {
  createCharge: Pick<CreateCharge, 'execute'>;
  getCharge: Pick<GetCharge, 'execute'>;
  getSettlement: Pick<GetSettlement, 'execute'>;
  responseTimeoutMs: number;
  sleep?: (ms: number) => Promise<void>;
  log?: ErrorLogger;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function buildApp(deps: AppDependencies): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => done());
  });

  registerErrorHandling(app, deps.log);

  await app.register(healthRoute);
  await app.register(chargesRoutes, {
    createCharge: deps.createCharge,
    getCharge: deps.getCharge,
    responseTimeoutMs: deps.responseTimeoutMs,
    sleep: deps.sleep ?? realSleep,
  });
  await app.register(settlementsRoutes, { getSettlement: deps.getSettlement });
  return app;
}
