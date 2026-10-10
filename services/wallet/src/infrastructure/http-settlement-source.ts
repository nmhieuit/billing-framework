import { ReconciliationTooLargeError, SettlementUnavailableError } from '../application/errors.js';
import type { SettlementSource } from '../application/ports.js';
import type { GatewayCharge } from '../domain/reconciliation.js';

export interface HttpSettlementSourceOptions {
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/** Cỡ trang lớn nhất mà payment cho phép. */
const PAGE_LIMIT = 1000;

interface Page {
  items: GatewayCharge[];
  nextCursor: string | null;
}

const malformed = (what: string): SettlementUnavailableError =>
  new SettlementUnavailableError(`malformed settlement response: ${what}`);

function parseItem(raw: unknown): GatewayCharge {
  if (typeof raw !== 'object' || raw === null) throw malformed('item is not an object');
  const { chargeId, reference, amount, currency, status, metadata } = raw as Record<
    string,
    unknown
  >;
  if (typeof chargeId !== 'string' || chargeId === '') throw malformed('chargeId');
  if (typeof reference !== 'string' || reference === '') throw malformed('reference');
  if (typeof amount !== 'number' || !Number.isSafeInteger(amount)) throw malformed('amount');
  if (typeof currency !== 'string' || currency === '') throw malformed('currency');
  if (status !== 'SUCCEEDED' && status !== 'FAILED') throw malformed('status');
  const tenant =
    typeof metadata === 'object' && metadata !== null
      ? (metadata as Record<string, unknown>).tenantId
      : undefined;
  return {
    chargeId,
    reference,
    amount,
    currency,
    status,
    tenantId: typeof tenant === 'string' && tenant !== '' ? tenant : null,
  };
}

function parsePage(body: unknown): Page {
  if (typeof body !== 'object' || body === null) throw malformed('body is not an object');
  const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
  if (!Array.isArray(items)) throw malformed('items');
  if (nextCursor !== null && typeof nextCursor !== 'string') throw malformed('nextCursor');
  return { items: items.map(parseItem), nextCursor };
}

/** Đọc sao kê cuối ngày của payment (`GET /settlements`), duyệt hết các trang bằng cursor. */
export class HttpSettlementSource implements SettlementSource {
  constructor(private readonly options: HttpSettlementSourceOptions) {}

  async fetchDay(day: string, maxCharges: number): Promise<GatewayCharge[]> {
    const doFetch = this.options.fetchImpl ?? fetch;
    const charges: GatewayCharge[] = [];
    let cursor: string | null = null;
    do {
      const url = new URL(`${this.options.baseUrl}/settlements`);
      url.searchParams.set('date', day);
      url.searchParams.set('limit', String(PAGE_LIMIT));
      if (cursor !== null) url.searchParams.set('cursor', cursor);

      let body: unknown;
      try {
        const response = await doFetch(url, {
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
        if (response.status !== 200) throw new Error(`HTTP ${response.status}`);
        body = await response.json();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new SettlementUnavailableError(`settlement request for ${day} failed: ${message}`);
      }

      const page = parsePage(body);
      charges.push(...page.items);
      if (charges.length > maxCharges) {
        throw new ReconciliationTooLargeError(
          `settlement for ${day} has more than ${maxCharges} charges`,
        );
      }
      cursor = page.nextCursor;
    } while (cursor !== null);
    return charges;
  }
}
