import type { TenantId } from '../domain/tenant-id.js';

export interface TenantRegistry {
  /** Biến chuỗi thô (header, metadata) thành `TenantId` hợp lệ và có trong cấu hình. */
  resolve(raw: string | undefined): TenantId;
  all(): readonly TenantId[];
}
