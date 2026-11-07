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
      const topupCopy = { ...topup };

      // Gọi payment (bất đồng bộ). Debug: log result để biết payment trả gì.
      const result = await deps.submit(topupCopy);

      // Nhánh created: payment đã nhận -> đổi sang PENDING. 'unavailable' thì giữ nguyên REQUESTED.
      if (result === 'created') {
        topup.status = 'PENDING';
      }
    } catch (error) {
      // Bắt hết lỗi ngay tại đây để không bao giờ rơi ra ngoài làm crash server.
      // Rủi ro: nếu deps.log tự ném lỗi ở dòng dưới, lỗi đó KHÔNG còn được bắt nữa.
      const errorMessage = (error as Error).message;
      deps.log(`submit failed: ${errorMessage}`);
    }
  }

  // Route tạo topup
  async function handleCreateTopup(request: any, reply: any) {
    const body = request.body as { amount: number };

    // id tăng dần: t1, t2, ... (dựa vào số topup đang có trong Map)
    const nextNumber = topups.size + 1;
    const newId = 't' + nextNumber;
    const topup: Topup = { id: newId, amount: body.amount, status: 'REQUESTED' };
    topups.set(topup.id, topup);

    // Bắt đầu job nền nhưng KHÔNG await -> không chờ, trả lời client ngay
    const job = submitInBackground(topup);
    runningJobs.add(job);

    // Khi job xong thì bỏ khỏi danh sách
    function removeFinishedJob() {
      runningJobs.delete(job);
    }
    job.then(removeFinishedJob);

    // 202 = Accepted (đã nhận yêu cầu, đang xử lý)
    const acceptedReply = reply.code(202);
    return acceptedReply.send({ id: topup.id, status: topup.status });
  }
  app.post('/topups', handleCreateTopup);

  // Route xem một topup
  async function handleGetTopup(request: any, reply: any) {
    const params = request.params as { id: string };
    const topup = topups.get(params.id);

    // Nhánh không tìm thấy: trả 404
    if (topup === undefined) {
      const notFoundReply = reply.code(404);
      return notFoundReply.send({ error: 'topup not found' });
    }

    // Nhánh tìm thấy: trả topup hiện tại (Fastify tự đổi thành JSON, mã 200)
    return topup;
  }
  app.get('/topups/:id', handleGetTopup);

  // Chờ mọi job nền đang chạy hoàn thành (dùng trong test và khi tắt server)
  async function drain(): Promise<void> {
    await Promise.all(runningJobs);
  }

  return { app, drain };
}
