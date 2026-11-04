// Bài 6 (Nâng cao): trả lời 202 ngay, gửi sang payment ở chạy nền.
// buildApp({ submit, log }) trả về { app, drain }.
//   POST /topups body { amount }:
//       tạo topup { id: 't1', amount, status: 'REQUESTED' } (id tăng dần), lưu vào Map,
//       trả NGAY 202 { id, status: 'REQUESTED' } — KHÔNG chờ submit.
//       Chạy nền: await submit(topup). Nếu submit trả 'created' -> status PENDING.
//       Nếu submit trả 'unavailable' -> giữ nguyên REQUESTED.
//       Nếu submit ném lỗi -> gọi log(`submit failed: ${error.message}`), giữ nguyên REQUESTED, KHÔNG để lỗi rơi ra ngoài.
//   GET /topups/:id -> 200 topup hiện tại | 404 { error: 'topup not found' }
//   drain(): trả Promise hoàn thành khi MỌI công việc chạy nền đã xong (dùng cho test, và khi tắt server).
import Fastify from 'fastify';

export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING';
}

// Các thứ app cần từ bên ngoài (truyền vào để test thay bằng bản giả được)
export interface Deps {
  submit: (topup: Topup) => Promise<'created' | 'unavailable'>; // hàm gửi sang payment
  log: (line: string) => void; // hàm ghi log
}

export function buildApp(deps: Deps) {
  const app = Fastify();

  // Kho lưu topup theo id
  const topups = new Map<string, Topup>();

  // Danh sách các job nền đang chạy dở (để drain() biết phải chờ cái nào)
  const runningJobs = new Set<Promise<void>>();

  // Việc chạy nền: gửi sang payment rồi cập nhật trạng thái
  async function submitInBackground(topup: Topup): Promise<void> {
    try {
      // Truyền bản sao để bên ngoài không sửa được topup gốc
      const result = await deps.submit({ ...topup });
      if (result === 'created') {
        topup.status = 'PENDING'; // 'unavailable' thì giữ nguyên REQUESTED
      }
    } catch (error) {
      // Bắt hết lỗi ngay tại đây để không bao giờ rơi ra ngoài làm crash server
      deps.log(`submit failed: ${(error as Error).message}`);
    }
  }

  app.post('/topups', async function (request, reply) {
    const body = request.body as { amount: number };

    // id tăng dần: t1, t2, ...
    const topup: Topup = { id: 't' + (topups.size + 1), amount: body.amount, status: 'REQUESTED' };
    topups.set(topup.id, topup);

    // Bắt đầu job nền nhưng KHÔNG await -> không chờ, trả lời client ngay
    const job = submitInBackground(topup);
    runningJobs.add(job);
    // Khi job xong thì bỏ khỏi danh sách
    job.then(function () {
      runningJobs.delete(job);
    });

    // 202 = Accepted (đã nhận yêu cầu, đang xử lý)
    return reply.code(202).send({ id: topup.id, status: topup.status });
  });

  app.get('/topups/:id', async function (request, reply) {
    const params = request.params as { id: string };
    const topup = topups.get(params.id);
    if (topup === undefined) {
      return reply.code(404).send({ error: 'topup not found' });
    }
    return topup;
  });

  // Chờ mọi job nền đang chạy hoàn thành (dùng trong test và khi tắt server)
  async function drain(): Promise<void> {
    await Promise.all(runningJobs);
  }

  return { app, drain };
}
