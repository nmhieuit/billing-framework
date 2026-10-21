import Fastify from 'fastify';

export function buildApp() {
  const app = Fastify();
  app.get('/me', async (request, reply) => {
    const customerId = request.headers['x-customer-id'];
    if (typeof customerId !== 'string' || customerId === '') {
      return reply.code(401).send({ error: 'x-customer-id header is required' });
    }
    return { customerId };
  });
  return app;
}
