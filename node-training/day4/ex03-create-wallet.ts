// Bài 3 (Trung bình): POST /wallets với body JSON { "owner": "An" }.
//   Thành công: mã 201, trả về { id: 'w1', owner: 'An', balance: 0 }   (id tăng dần: w1, w2, ...)
//   owner thiếu / không phải chuỗi / chuỗi rỗng: mã 400, { error: 'owner is required' }
import Fastify from 'fastify';

// Hình dạng của một ví
export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp() {
  const app = Fastify();

  // Map: kho lưu ví trong bộ nhớ, khóa là id ví, giá trị là đối tượng ví
  const wallets = new Map<string, Wallet>();

  // Route POST: tạo ví mới. "reply" dùng để tự chọn mã trạng thái và nội dung trả về
  app.post('/wallets', async function (request, reply) {
    // request.body là dữ liệu JSON client gửi lên. Có thể thiếu body nên cho phép null
    const body = request.body as { owner?: unknown } | null;

    // Kiểm tra owner: phải là chuỗi và không rỗng
    if (body === null || typeof body.owner !== 'string' || body.owner === '') {
      // 400 = Bad Request (client gửi dữ liệu sai)
      return reply.code(400).send({ error: 'owner is required' });
    }

    // Tạo id tăng dần: ví đầu tiên là w1, ví thứ hai là w2, ...
    const newId = 'w' + (wallets.size + 1);
    const wallet: Wallet = { id: newId, owner: body.owner, balance: 0 };

    // Lưu ví vào kho
    wallets.set(wallet.id, wallet);

    // 201 = Created (đã tạo thành công)
    return reply.code(201).send(wallet);
  });

  return app;
}
