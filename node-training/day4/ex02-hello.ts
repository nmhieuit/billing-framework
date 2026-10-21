// Bài 2 (Cơ bản): tham số trên đường dẫn.
// GET /hello/An  ->  200 { "message": "Xin chào, An!" }
// Gợi ý: app.get('/hello/:name', ...) và (request.params as { name: string }).name
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  // TODO
  return app;
}
