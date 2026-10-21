import Fastify from 'fastify';

export async function buildApp() {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  app.get('/version', async () => ({ version: '1.0.0' }));
  await app.ready();
  return app;
}
