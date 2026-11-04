// Payment GIẢ để thực hành (đã viết sẵn, không cần sửa).
// POST /charges body { amount } -> 202 { chargeId } khi ok
// Mỗi lần gọi lấy hành vi theo thứ tự trong `script` (hết thì lặp lại phần tử cuối):
//   'ok'     trả 202 ngay
//   'slow'   chờ `slowMs` rồi mới trả 202 (mô phỏng payment chậm)
//   'error'  trả 500
//   'reject' trả 422 (từ chối nghiệp vụ, thử lại cũng vô ích)
import Fastify from 'fastify';

// 4 hành vi mà payment giả có thể thực hiện
export type Behavior = 'ok' | 'slow' | 'error' | 'reject';

// Những gì test nhận lại khi khởi động payment giả
export interface FakePayment {
  url: string; // địa chỉ để gọi, ví dụ http://127.0.0.1:54321
  calls: () => number; // hỏi xem đã bị gọi bao nhiêu lần
  close: () => Promise<void>; // tắt server khi test xong
}

export async function startFakePayment(script: Behavior[] = ['ok'], slowMs = 1000): Promise<FakePayment> {
  const app = Fastify();
  let calls = 0; // đếm số lần route /charges bị gọi

  app.post('/charges', async function (_request, reply) {
    // Chọn hành vi theo lượt gọi. Math.min giữ chỉ số không vượt quá phần tử cuối của script
    const index = Math.min(calls, script.length - 1);
    const behavior = script[index] ?? 'ok';
    calls = calls + 1;

    // 'slow': chờ một lúc rồi mới trả lời (đi tiếp xuống cuối hàm để trả 202)
    if (behavior === 'slow') {
      await new Promise(function (resolve) {
        setTimeout(resolve, slowMs);
      });
    }
    if (behavior === 'error') {
      return reply.code(500).send({ error: 'boom' });
    }
    if (behavior === 'reject') {
      return reply.code(422).send({ error: 'rejected' });
    }
    // 'ok' hoặc 'slow': nhận yêu cầu thành công, trả chargeId (ch_1, ch_2, ...)
    return reply.code(202).send({ chargeId: 'ch_' + calls });
  });

  // port: 0 nghĩa là để hệ điều hành tự chọn một cổng còn trống
  await app.listen({ port: 0, host: '127.0.0.1' });

  // Hỏi lại server xem nó thực sự đang nghe ở cổng nào
  const address = app.server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls: function () {
      return calls;
    },
    close: function () {
      return app.close();
    },
  };
}
