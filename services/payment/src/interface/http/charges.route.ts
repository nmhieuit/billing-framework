import type { FastifyPluginAsync } from 'fastify';
import type { CreateCharge } from '../../application/create-charge.js';
import type { GetCharge } from '../../application/get-charge.js';
import { RequestValidationError } from './errors.js';

export interface ChargesRoutesOptions {
  createCharge: Pick<CreateCharge, 'execute'>;
  getCharge: Pick<GetCharge, 'execute'>;
  responseTimeoutMs: number;
  sleep: (ms: number) => Promise<void>;
}

const MAX_KEY_LENGTH = 255;

const first = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export const chargesRoutes: FastifyPluginAsync<ChargesRoutesOptions> = async (app, options) => {
  app.post('/charges', async (request, reply) => {
    const key = first(request.headers['idempotency-key']);
    if (key === undefined || key.trim() === '') {
      throw new RequestValidationError(
        'MISSING_IDEMPOTENCY_KEY',
        'Idempotency-Key header is required',
      );
    }
    if (key !== key.trim()) {
      throw new RequestValidationError(
        'INVALID_IDEMPOTENCY_KEY',
        'Idempotency-Key must not have leading or trailing whitespace',
      );
    }
    if (key.length > MAX_KEY_LENGTH) {
      throw new RequestValidationError(
        'INVALID_IDEMPOTENCY_KEY',
        `Idempotency-Key must be at most ${MAX_KEY_LENGTH} characters`,
      );
    }

    const body = request.body;
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      throw new RequestValidationError('INVALID_REQUEST', 'request body must be a JSON object');
    }
    const { amount, currency, reference, metadata } = body as Record<string, unknown>;
    if (typeof amount !== 'number') {
      throw new RequestValidationError('INVALID_REQUEST', 'amount must be a number');
    }
    if (typeof currency !== 'string') {
      throw new RequestValidationError('INVALID_REQUEST', 'currency must be a string');
    }
    if (typeof reference !== 'string') {
      throw new RequestValidationError('INVALID_REQUEST', 'reference must be a string');
    }

    const result = await options.createCharge.execute({
      idempotencyKey: key,
      amount,
      currency,
      reference,
      metadata,
      simulate: first(request.headers['x-simulate']),
    });

    // response=timeout: charge đã được tạo nhưng phản hồi bị giữ lại để client thấy timeout.
    if (result.responseTimeout) await options.sleep(options.responseTimeoutMs);
    return reply.code(result.status).send(result.body);
  });

  app.get<{ Params: { id: string } }>('/charges/:id', async (request) =>
    options.getCharge.execute(request.params.id),
  );
};
