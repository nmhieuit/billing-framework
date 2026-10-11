/** Thứ tự này là thứ tự khóa ngoại: item trước run, rồi các bảng độc lập. */
export const WALLET_RETENTION_POLICIES = [
  'reconciliation_items',
  'reconciliation_runs',
  'outbox_sent',
  'processed_messages',
  'idempotency_keys',
] as const;

export type WalletRetentionPolicy = (typeof WALLET_RETENTION_POLICIES)[number];

/** Trần khi đếm ở chế độ chạy thử (tránh đếm bảng khổng lồ). */
export const DRY_RUN_COUNT_CAP = 1_000_000;

export interface RetentionRepository {
  /**
   * Một lô: xóa tối đa `batchSize` dòng đủ điều kiện và trả số dòng đã xóa; khi `dryRun` chỉ đếm
   * (có trần `DRY_RUN_COUNT_CAP`) và không xóa gì.
   */
  purge(
    policy: WalletRetentionPolicy,
    cutoff: Date,
    batchSize: number,
    dryRun: boolean,
  ): Promise<number>;
}
