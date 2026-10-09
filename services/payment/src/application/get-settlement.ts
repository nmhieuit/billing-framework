import { InvalidSettlementQueryError } from './errors.js';
import type { Clock, CompletedCursor, SettlementTotal, UnitOfWork } from './ports.js';

export const DEFAULT_LIMIT = 500;
export const MAX_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SettlementQuery {
  date: string;
  limit?: number | undefined;
  cursor?: string | undefined;
}

export interface SettlementItem {
  chargeId: string;
  reference: string;
  amount: number;
  currency: string;
  status: 'SUCCEEDED' | 'FAILED';
  failureCode?: string;
  completedAt: string;
}

export interface SettlementView {
  date: string;
  items: SettlementItem[];
  nextCursor: string | null;
  totals: SettlementTotal[];
}

function parseDay(date: string, now: Date): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new InvalidSettlementQueryError('date must be formatted as YYYY-MM-DD');
  }
  const from = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(from.getTime()) || from.toISOString().slice(0, 10) !== date) {
    throw new InvalidSettlementQueryError('date is not a valid calendar date');
  }
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  if (from.getTime() > startOfToday) {
    throw new InvalidSettlementQueryError('date must not be in the future');
  }
  return from;
}

function parseLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new InvalidSettlementQueryError(`limit must be an integer in 1..${MAX_LIMIT}`);
  }
  return limit;
}

function encodeCursor(cursor: CompletedCursor): string {
  return Buffer.from(
    JSON.stringify({ c: cursor.completedAt.toISOString(), i: cursor.id }),
  ).toString('base64url');
}

function decodeCursor(raw: string): CompletedCursor {
  const invalid = () => new InvalidSettlementQueryError('cursor is invalid');
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (typeof parsed !== 'object' || parsed === null) throw invalid();
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || i === '') throw invalid();
  const completedAt = new Date(c);
  if (Number.isNaN(completedAt.getTime()) || completedAt.toISOString() !== c) throw invalid();
  return { completedAt, id: i };
}

export class GetSettlement {
  constructor(private readonly deps: { uow: UnitOfWork; clock: Clock }) {}

  async execute(query: SettlementQuery): Promise<SettlementView> {
    const from = parseDay(query.date, this.deps.clock.now());
    const limit = parseLimit(query.limit);
    const after = query.cursor === undefined ? null : decodeCursor(query.cursor);
    const to = new Date(from.getTime() + DAY_MS);

    const { rows, totals } = await this.deps.uow.run(async ({ charges }) => ({
      // Lấy dư một dòng để biết còn trang sau hay không.
      rows: await charges.listCompleted({ from, to, limit: limit + 1, after }),
      totals: await charges.totals({ from, to }),
    }));

    const page = rows.slice(0, limit);
    const items: SettlementItem[] = page.map((charge) => {
      const p = charge.toProps();
      return {
        chargeId: p.id,
        reference: p.reference,
        amount: p.amount.amount,
        currency: p.amount.currency,
        status: p.status as 'SUCCEEDED' | 'FAILED',
        ...(p.failureCode === null ? {} : { failureCode: p.failureCode }),
        completedAt: (p.completedAt ?? p.createdAt).toISOString(),
      };
    });

    const last = page.at(-1)?.toProps();
    const nextCursor =
      rows.length > limit && last?.completedAt
        ? encodeCursor({ completedAt: last.completedAt, id: last.id })
        : null;

    return { date: query.date, items, nextCursor, totals };
  }
}
