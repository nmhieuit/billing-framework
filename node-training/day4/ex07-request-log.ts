// Bài 7 (Nâng cao): ghi log mỗi request bằng hook.
// buildApp(log) nhận một hàm log(line: string). Sau MỖI response, gọi log với đúng dạng:
//   'GET /health 200'      (METHOD URL STATUS)
// Gợi ý: app.addHook('onResponse', async (request, reply) => { ... }) như ví dụ d-hook.ts
import Fastify from 'fastify';

export function buildApp(log: (line: string) => void) {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  app.post('/echo', async (request) => request.body);
  // TODO: addHook
  void log;
  return app;
}
