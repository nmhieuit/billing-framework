import Fastify from 'fastify';

export interface Wallet {
  id: string;
  owner: string;
  balance: number;
}

export function buildApp() {
  const app = Fastify();
  const wallets = new Map<string, Wallet>();

  app.post('/wallets', async (request, reply) => {
    const body = request.body as { owner?: unknown } | null;
    if (typeof body?.owner !== 'string' || body.owner === '') {
      return reply.code(400).send({ error: 'owner is required' });
    }
    const wallet: Wallet = { id: `w${wallets.size + 1}`, owner: body.owner, balance: 0 };
    wallets.set(wallet.id, wallet);
    return reply.code(201).send(wallet);
  });

  return app;
}
