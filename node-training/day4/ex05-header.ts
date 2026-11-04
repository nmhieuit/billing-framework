// Bài 5 (Trung bình): đọc header.
// GET /me
//   có header x-customer-id: 200 { customerId: <giá trị header> }
//   thiếu header:            401 { error: 'x-customer-id header is required' }
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();

  app.get('/me', async function (request, reply) {
    // Header là thông tin phụ gửi kèm request. Node luôn viết thường tên header
    const customerId = request.headers['x-customer-id'];

    // Không có header thì giá trị là undefined
    if (!customerId) {
      // 401 = Unauthorized (chưa xác định được người gọi)
      return reply.code(401).send({ error: 'x-customer-id header is required' });
    }

    return { customerId };
  });

  return app;
}
