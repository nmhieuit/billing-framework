import { ConfigError, createDatabase, migratorConfigFromEnv } from '@billing/database';
import { TenantId } from '../../services/wallet/src/domain/tenant-id.js';
import { provisionTenants } from '../../services/wallet/src/infrastructure/kysely/provisioning.js';

function parseTenants(raw: string | undefined): TenantId[] {
  const parts = (raw ?? '')
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '');
  if (parts.length === 0) throw new ConfigError(['WALLET_TENANTS is required']);
  return parts.map((part) => TenantId.parse(part));
}

try {
  // Migrator của Kysely cần tài khoản thuộc db_owner; tài khoản ứng dụng chỉ cần DML.
  const config = migratorConfigFromEnv('WALLET_DB', 'WALLET_MIGRATOR_DB', process.env);
  const tenants = parseTenants(process.env.WALLET_TENANTS);

  const db = createDatabase<unknown>(config);
  try {
    const applied = await provisionTenants(db, tenants);
    for (const [tenant, names] of Object.entries(applied)) {
      console.log(`${tenant}: ${names.length > 0 ? `applied ${names.join(', ')}` : 'up to date'}`);
    }
  } finally {
    await db.destroy();
  }
} catch (error) {
  if (error instanceof ConfigError) {
    console.error(error.message);
    process.exit(1);
  }
  throw error;
}
