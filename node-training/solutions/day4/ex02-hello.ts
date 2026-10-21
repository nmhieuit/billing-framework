import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  app.get('/hello/:name', async (request) => {
    const { name } = request.params as { name: string };
    return { message: `Xin chào, ${name}!` };
  });
  return app;
}
