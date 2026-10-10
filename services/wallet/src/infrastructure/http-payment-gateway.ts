import type {
  GatewayChargeRequest,
  GatewayChargeResult,
  PaymentGateway,
} from '../application/ports.js';

export interface HttpPaymentGatewayOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Các mã 4xx mà việc thử lại có thể có ích. */
const RETRYABLE_CLIENT_ERRORS = new Set([408, 429]);

export class HttpPaymentGateway implements PaymentGateway {
  constructor(private readonly options: HttpPaymentGatewayOptions) {}

  async createCharge(request: GatewayChargeRequest): Promise<GatewayChargeResult> {
    const doFetch = this.options.fetchImpl ?? fetch;
    try {
      const response = await doFetch(`${this.options.baseUrl}/charges`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': request.idempotencyKey,
        },
        body: JSON.stringify({
          amount: request.amount.amount,
          currency: request.amount.currency,
          reference: request.reference,
          metadata: request.metadata,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
      const text = await response.text().catch(() => '');
      let parsed: unknown;
      try {
        parsed = text === '' ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }

      if (response.status === 202) {
        const chargeId = (parsed as { chargeId?: unknown } | undefined)?.chargeId;
        if (typeof chargeId === 'string' && chargeId !== '') return { kind: 'created', chargeId };
        return { kind: 'unavailable', error: 'malformed response from payment (missing chargeId)' };
      }
      if (
        response.status >= 400 &&
        response.status < 500 &&
        !RETRYABLE_CLIENT_ERRORS.has(response.status)
      ) {
        const message = (parsed as { error?: { message?: unknown } } | undefined)?.error?.message;
        return {
          kind: 'rejected',
          status: response.status,
          message: typeof message === 'string' ? message : `HTTP ${response.status}`,
        };
      }
      return { kind: 'unavailable', error: `HTTP ${response.status}` };
    } catch (error) {
      return { kind: 'unavailable', error: error instanceof Error ? error.message : String(error) };
    }
  }
}
