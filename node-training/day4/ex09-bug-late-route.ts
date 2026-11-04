// Bài 9 (Sửa lỗi): buildApp ném lỗi khi khởi tạo (mã FST_ERR_...).
// Lý do: sau khi gọi app.ready() Fastify đã "khóa" danh sách route, không cho thêm route mới.
// Cách sửa: khai báo TẤT CẢ route trước, rồi mới gọi app.ready().
import Fastify from 'fastify';

export async function buildApp() {
  const app = Fastify();

  // Khai báo mọi route trước
  app.get('/health', async function () {
    return { status: 'ok' };
  });
  app.get('/version', async function () {
    return { version: '1.0.0' };
  });

  // Cuối cùng mới gọi ready() để khởi động xong ứng dụng
  await app.ready();
  return app;
}
