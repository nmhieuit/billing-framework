import type { Migration } from '@billing/database';
import { assertSchemaName } from '../schema-name.js';
import { ledgerMigration } from './001-ledger.js';
import { topupsMigration } from './002-topups.js';

/** Các migration của một schema tenant. Tên quyết định thứ tự; chỉ thêm mới, không sửa cái đã phát hành. */
export function walletMigrations(schema: string): Record<string, Migration> {
  assertSchemaName(schema);
  return {
    '001-ledger': ledgerMigration(schema),
    '002-topups': topupsMigration(schema),
  };
}
