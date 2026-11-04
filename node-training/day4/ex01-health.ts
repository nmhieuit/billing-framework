// Bài 1 (Cơ bản): GET /health trả về { status: 'ok' } (mã 200).
import Fastify from 'fastify';

// buildApp tạo ra một server Fastify (chưa lắng nghe cổng nào)
// -> nhờ vậy test có thể gọi thử bằng app.inject mà không cần mở cổng thật
export function buildApp() {
  // Tạo ứng dụng Fastify
  const app = Fastify();

  // Khai báo route: khi có request GET /health thì chạy hàm bên dưới
  app.get('/health', async function () {
    // Trả về đối tượng, Fastify tự đổi thành JSON và đặt mã 200
    return { status: 'ok' };
  });

  return app;
}
