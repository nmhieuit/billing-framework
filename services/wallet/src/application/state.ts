/** Ảnh chụp trạng thái của MỘT tenant để xuất thành gauge. Tuổi tính bằng giây tại thời điểm chụp. */
export interface TenantState {
  tenant: string;
  outboxPending: number;
  outboxOldestAgeSeconds: number;
  topupsRequestedBacklog: number;
  topupsOldestRequestedAgeSeconds: number;
  openItemsByKind: Readonly<Record<string, number>>;
  oldestOpenItemAgeSeconds: number;
  /** `null` khi tenant chưa có lượt đối soát nào hoàn tất. */
  lastReconciliationSuccessAgeSeconds: number | null;
}

export interface WalletState {
  tenants: readonly TenantState[];
  /** `null` khi không đọc được (mất kết nối broker hoặc queue không truy cập được). */
  dlqDepth: number | null;
}
