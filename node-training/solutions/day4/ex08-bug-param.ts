import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  const wallets = new Map([['w1', { id: 'w1', owner: 'An', balance: 10 }]]);

  app.get('/wallets/:walletId', async (request, reply) => {
    const { walletId } = request.params as { walletId: string };
    const wallet = wallets.get(walletId);
    if (!wallet) {
      return reply.code(404).send({ error: 'wallet not found' });
    }
    return wallet;
  });

  return app;
}
