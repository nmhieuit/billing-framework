import Fastify from 'fastify';

export function buildApp(log: (line: string) => void) {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/echo', async (request) => request.body);
  app.addHook('onResponse', async (request, reply) => {
    log(`${request.method} ${request.url} ${reply.statusCode}`);
  });
  return app;
}
