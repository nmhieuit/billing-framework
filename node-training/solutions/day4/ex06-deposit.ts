import Fastify from 'fastify';

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp(wallets: Map<string, Wallet> = new Map()) {
  const app = Fastify();

  app.post('/wallets/:id/deposit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const wallet = wallets.get(id);
    if (!wallet) {
      return reply.code(404).send({ error: 'wallet not found' });
    }
    const body = request.body as { amount?: unknown } | null;
    const amount = body?.amount;
    if (typeof amount !== 'number' || !Number.isInteger(amount) || amount <= 0) {
      return reply.code(400).send({ error: 'amount must be a positive integer' });
    }
    wallet.balance += amount;
    return { id: wallet.id, balance: wallet.balance };
  });

  return app;
}
