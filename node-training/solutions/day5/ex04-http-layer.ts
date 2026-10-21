import Fastify from 'fastify';
import { InvalidAmountError, WalletNotFoundError } from './support/errors.js';
import type { WalletService } from './support/wallet-service.js';

export function buildApp(service: WalletService) {
  const app = Fastify();

  app.get('/wallets/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      return service.get(id);
    } catch (error) {
      if (error instanceof WalletNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  app.post('/wallets/:id/deposit', async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { amount?: number } | null;
    try {
      return service.deposit(id, body?.amount as number);
    } catch (error) {
      if (error instanceof InvalidAmountError) {
        return reply.code(400).send({ error: error.message });
      }
      if (error instanceof WalletNotFoundError) {
        return reply.code(404).send({ error: error.message });
      }
      throw error;
    }
  });

  return app;
}
