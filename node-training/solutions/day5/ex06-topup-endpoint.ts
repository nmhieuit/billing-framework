import Fastify from 'fastify';

interface Saved {
  fingerprint: string;
  status: number;
  body: unknown;
}

export function buildApp() {
  const app = Fastify();
  const saved = new Map<string, Saved>();
  let balance = 0;
  let counter = 0;

  app.post('/topups', async (request, reply) => {
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || key === '') {
      return reply.code(400).send({ error: 'idempotency-key header is required' });
    }
    const body = request.body as { amount?: unknown } | null;
    const amount = body?.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive integer' });
    }

    const fingerprint = JSON.stringify(body);
    const previous = saved.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) {
        return reply.code(422).send({ error: 'IDEMPOTENCY_KEY_REUSED' });
      }
      return reply.header('idempotent-replayed', 'true').code(previous.status).send(previous.body);
    }

    counter += 1;
    balance += amount;
    const response = { topupId: `t${counter}`, amount, balance };
    saved.set(key, { fingerprint, status: 201, body: response });
    return reply.code(201).send(response);
  });

  return app;
}
