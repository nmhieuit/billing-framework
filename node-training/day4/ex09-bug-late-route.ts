// Bài 9 (Sửa lỗi): buildApp ném lỗi khi khởi tạo. Đọc thông báo lỗi (có mã FST_ERR_...)
// và nghĩ: vì sao không thể thêm route SAU khi gọi app.ready()? Chỉ sửa thứ tự các dòng.
import Fastify from 'fastify';

export async function buildApp() {
  const app = Fastify();
  app.get('/health', async () => ({ status: 'ok' }));
  await app.ready();
  app.get('/version', async () => ({ version: '1.0.0' }));
  return app;
}
