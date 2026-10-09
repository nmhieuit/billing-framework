import Fastify, { type FastifyInstance } from 'fastify';
import {
  CORRELATION_HEADER,
  resolveCorrelationId,
  runWithCorrelation,
} from '@billing/observability';
import { healthRoute } from './health.route.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  app.addHook('onRequest', (request, reply, done) => {
    const correlationId = resolveCorrelationId(request.headers[CORRELATION_HEADER]);
    reply.header(CORRELATION_HEADER, correlationId);
    runWithCorrelation(correlationId, () => done());
  });

  await app.register(healthRoute);
  return app;
}
