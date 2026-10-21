import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  app.addHook('onResponse', async (request, reply) => {
    console.log(`${request.method} ${request.url} -> ${reply.statusCode}`);
  });

  app.get('/health', async () => ({ status: 'ok' }));
  return app;
}
