import type { Migration } from '@billing/database';
import * as init from './001-init.js';

/** Tên migration quyết định thứ tự chạy; chỉ thêm mới, không sửa migration đã phát hành. */
export const paymentMigrations: Record<string, Migration> = {
  '001-init': init,
};
