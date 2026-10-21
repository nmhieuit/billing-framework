// Bài 1 (Cơ bản): GET /health trả về { status: 'ok' } (mã 200).
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  // TODO: app.get('/health', async () => { ... });
  return app;
}
