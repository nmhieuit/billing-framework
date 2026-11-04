// Bài 2 (Cơ bản): tham số trên đường dẫn.
// GET /hello/An  ->  200 { "message": "Xin chào, An!" }
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  // ":name" trong đường dẫn là tham số: /hello/An thì name = 'An'
  app.get('/hello/:name', async function (request) {
    // request.params chứa các tham số trên đường dẫn.
    // "as { name: string }" báo cho TypeScript biết hình dạng của params
    const params = request.params as { name: string };
    const name = params.name;

    return { message: `Xin chào, ${name}!` };
  });

  return app;
}
