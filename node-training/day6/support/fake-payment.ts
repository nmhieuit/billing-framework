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

  // Hàm xử lý mỗi request POST /charges
  async function handleCharge(_request: any, reply: any) {
    // Chọn hành vi theo lượt gọi. Math.min giữ chỉ số không vượt quá phần tử cuối của script
    const index = Math.min(calls, script.length - 1);

    // ?? 'ok': nếu script rỗng thì phần tử là undefined, khi đó mặc định dùng 'ok'
    const behavior = script[index] ?? 'ok';
    calls = calls + 1;

    // Nhánh 'slow': chờ một lúc rồi mới trả lời (đi tiếp xuống cuối hàm để trả 202)
    if (behavior === 'slow') {
      // Hàm được Promise gọi ngay; sau slowMs mili-giây thì gọi resolve để hết chờ
      function startSlowTimer(resolve: () => void): void {
        setTimeout(resolve, slowMs);
      }
      const slowPromise = new Promise<void>(startSlowTimer);
      await slowPromise;
    }

    // Nhánh 'error': giả lập payment bị sự cố, trả 500
    if (behavior === 'error') {
      const errorReply = reply.code(500);
      return errorReply.send({ error: 'boom' });
    }

    // Nhánh 'reject': giả lập payment từ chối nghiệp vụ, trả 422
    if (behavior === 'reject') {
      const rejectReply = reply.code(422);
      return rejectReply.send({ error: 'rejected' });
    }

    // Nhánh 'ok' hoặc 'slow': nhận yêu cầu thành công, trả chargeId (ch_1, ch_2, ...)
    const chargeId = 'ch_' + calls;
    const acceptedReply = reply.code(202);
    return acceptedReply.send({ chargeId });
  }
  app.post('/charges', handleCharge);

  // port: 0 nghĩa là để hệ điều hành tự chọn một cổng còn trống
  await app.listen({ port: 0, host: '127.0.0.1' });

  // Hỏi lại server xem nó thực sự đang nghe ở cổng nào
  const address = app.server.address();

  // Mặc định 0; chỉ lấy cổng thật khi address là một đối tượng (không phải chuỗi hay null)
  let port = 0;
  if (typeof address === 'object' && address) {
    port = address.port;
  }

  // Hàm test dùng để hỏi số lần payment đã bị gọi
  function getCallCount(): number {
    return calls;
  }

  // Hàm test dùng để tắt server khi xong
  function closeServer(): Promise<void> {
    return app.close();
  }

  const fakePayment: FakePayment = {
    url: `http://127.0.0.1:${port}`,
    calls: getCallCount,
    close: closeServer,
  };
  return fakePayment;
}
