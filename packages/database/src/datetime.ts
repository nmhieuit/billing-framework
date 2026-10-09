import { sql, type RawBuilder } from 'kysely';

/**
 * tedious gửi `Date` bằng kiểu DateTime (độ chi tiết ~3,33 ms) nên làm mất mili-giây.
 * Truyền chuỗi ISO rồi cast sang datetime2(3) thì giữ chính xác từng mili-giây.
 */
export function dateTime(value: Date): RawBuilder<Date> {
  return sql<Date>`cast(${value.toISOString()} as datetime2(3))`;
}
