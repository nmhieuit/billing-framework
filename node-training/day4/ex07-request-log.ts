// Bài 7 (Nâng cao): ghi log mỗi request bằng hook.
// buildApp(log) nhận một hàm log(line: string). Sau MỖI response, gọi log với đúng dạng:
//   'GET /health -> 200'      (METHOD URL -> STATUS)
import Fastify from 'fastify';

export function buildApp(log: (line: string) => void) {
  const app = Fastify();

  app.get('/health', async function () {
    return { status: 'ok' };
  });

  // Route trả lại đúng body client gửi lên
  app.post('/echo', async function (request) {
    return request.body;
  });

  // Hook "onResponse": Fastify tự gọi hàm này sau khi đã gửi xong MỌI response
  // (kể cả response 404 của route không tồn tại)
  app.addHook('onResponse', async function (request, reply) {
    log(`${request.method} ${request.url} -> ${reply.statusCode}`);
  });

  return app;
}
