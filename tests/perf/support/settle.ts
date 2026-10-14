import { sql } from 'kysely';
import type { PerfEnv } from './perf-env.js';

/** Bảng của mỗi schema tenant mà tải đo ghi/đọc nhiều (thống kê của chúng bị seed làm lệch nếu không cập nhật). */
const STATISTICS_TABLES = [
  'topups',
  'accounts',
  'ledger_transactions',
  'ledger_entries',
  'order_payments',
  'outbox',
  'processed_messages',
] as const;

/**
 * Đưa kho lưu trữ về cùng một trạng thái trước MỖI lượt đo: seed hàng nghìn topup ngay trước cửa sổ đo để lại trang bẩn chưa
 * ghi đĩa, thống kê lỗi thời và auto-update statistics chạy giữa lượt, chỉ ảnh hưởng lần lặp đầu. CHECKPOINT ghi hết trang bẩn;
 * UPDATE STATISTICS làm mới thống kê (cố định kế hoạch truy vấn) ở mọi schema tenant.
 * `env.admin` nối thẳng vào database đo (testDb.config.database) nên CHECKPOINT chạy trong đúng database đó.
 *
 * Là thuộc tính của object `storage` (không phải hàm xuất trần) để test theo dõi được thứ tự gọi bằng vi.spyOn.
 */
export const storage = {
  async settle(env: PerfEnv): Promise<void> {
    await sql`checkpoint`.execute(env.admin);
    for (const tenant of env.tenants) {
      for (const table of STATISTICS_TABLES) {
        await sql`update statistics ${sql.id(`t_${tenant.value}`, table)}`.execute(env.admin);
      }
    }
  },
};
