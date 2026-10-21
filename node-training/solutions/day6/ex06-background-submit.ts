import Fastify from 'fastify';

export interface Topup {
  id: string;
  amount: number;
  status: 'REQUESTED' | 'PENDING';
}

export interface Deps {
  submit: (topup: Topup) => Promise<'created' | 'unavailable'>;
  log: (line: string) => void;
}

export function buildApp(deps: Deps) {
  const app = Fastify();
  const topups = new Map<string, Topup>();
  const pending = new Set<Promise<void>>();

  app.post('/topups', async (request, reply) => {
    const body = request.body as { amount: number };
    const topup: Topup = { id: `t${topups.size + 1}`, amount: body.amount, status: 'REQUESTED' };
    topups.set(topup.id, topup);

    const job: Promise<void> = (async () => {
      const result = await deps.submit({ ...topup });
      if (result === 'created') {
        topup.status = 'PENDING';
      }
    })()
      .catch((error: Error) => deps.log(`submit failed: ${error.message}`))
      .finally(() => pending.delete(job));
    pending.add(job);

    return reply.code(202).send({ id: topup.id, status: topup.status });
  });

  app.get('/topups/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const topup = topups.get(id);
    if (!topup) {
      return reply.code(404).send({ error: 'topup not found' });
    }
    return topup;
  });

  return { app, drain: async () => void (await Promise.all(pending)) };
}
