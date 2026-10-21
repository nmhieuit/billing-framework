import Fastify from 'fastify';

const app = Fastify();
const status = new Map<string, string>();
const pending = new Set<Promise<void>>();

const sendToPayment = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 200));

app.post('/topups', async (_request, reply) => {
  const id = `t${status.size + 1}`;
  status.set(id, 'REQUESTED');

  const job = (async () => {
    await sendToPayment();
    status.set(id, 'PENDING');
  })()
    .catch((error) => console.log('lỗi chạy nền:', error))
    .finally(() => pending.delete(job));
  pending.add(job);

  return reply.code(202).send({ id, status: 'REQUESTED' });
});

app.get('/topups/:id', async (request) => {
  const { id } = request.params as { id: string };
  return { id, status: status.get(id) };
});

const first = await app.inject({ method: 'POST', url: '/topups' });
console.log('ngay sau POST :', first.statusCode, first.json());
console.log('hỏi ngay      :', (await app.inject({ method: 'GET', url: '/topups/t1' })).json());
await Promise.all(pending);
console.log('sau khi chờ   :', (await app.inject({ method: 'GET', url: '/topups/t1' })).json());
