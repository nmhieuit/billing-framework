import type { FastifyPluginAsync } from 'fastify';
import type { GetSettlement } from '../../application/get-settlement.js';

export interface SettlementsRoutesOptions {
  getSettlement: Pick<GetSettlement, 'execute'>;
}

export const settlementsRoutes: FastifyPluginAsync<SettlementsRoutesOptions> = async (
  app,
  options,
) => {
  app.get('/settlements', async (request) => {
    const query = request.query as Record<string, unknown>;
    return options.getSettlement.execute({
      date: typeof query.date === 'string' ? query.date : '',
      // Không phải số thì thành NaN; use case từ chối và route trả 400 INVALID_QUERY.
      limit: query.limit === undefined ? undefined : Number(query.limit),
      cursor: typeof query.cursor === 'string' ? query.cursor : undefined,
    });
  });
};
