/** Thứ tự này là thứ tự khóa ngoại: attempt trước event, rồi bảng độc lập. */
export const PAYMENT_RETENTION_POLICIES = [
  'webhook_attempts',
  'webhook_events',
  'idempotency_keys',
] as const;

export type PaymentRetentionPolicy = (typeof PAYMENT_RETENTION_POLICIES)[number];

/** Trần khi đếm ở chế độ chạy thử (tránh đếm bảng khổng lồ). */
export const DRY_RUN_COUNT_CAP = 1_000_000;

export interface RetentionRepository {
  /**
   * Một lô: xóa tối đa `batchSize` dòng đủ điều kiện và trả số dòng đã xóa; khi `dryRun` chỉ đếm
   * (có trần `DRY_RUN_COUNT_CAP`) và không xóa gì.
   */
  purge(
    policy: PaymentRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number>;
}
