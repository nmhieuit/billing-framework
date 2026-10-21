// Bài 5 (Trung bình): đọc header.
// GET /me
//   có header x-customer-id: 200 { customerId: <giá trị header> }
//   thiếu header:            401 { error: 'x-customer-id header is required' }
// Gợi ý: request.headers['x-customer-id'] (Node luôn hạ chữ thường tên header).
import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  // TODO
  return app;
}
