/**
 * SQL Server `bigint` được tedious trả về dạng chuỗi. Chuyển về number có kiểm tra,
 * để tiền không bao giờ bị làm tròn âm thầm.
 */
export function toSafeInteger(value: string | number | bigint): number {
  let big: bigint | undefined;
  if (typeof value === 'bigint') {
    big = value;
  } else if (typeof value === 'number') {
    big = Number.isInteger(value) ? BigInt(value) : undefined;
  } else if (/^-?\d+$/.test(value)) {
    big = BigInt(value);
  }
  if (
    big === undefined ||
    big > BigInt(Number.MAX_SAFE_INTEGER) ||
    big < BigInt(Number.MIN_SAFE_INTEGER)
  ) {
    throw new RangeError(`not a safe integer: ${String(value)}`);
  }
  return Number(big);
}
