import { ConfigError, createDatabase, migrate, migratorConfigFromEnv } from '@billing/database';
import { paymentMigrations } from './migrations.js';

try {
  // Migrator của Kysely cần tài khoản thuộc db_owner; tài khoản ứng dụng chỉ cần DML.
  const config = migratorConfigFromEnv('PAYMENT_DB', 'PAYMENT_MIGRATOR_DB', process.env);
  const db = createDatabase<unknown>(config);
  try {
    const applied = await migrate(db, paymentMigrations);
    console.log(applied.length > 0 ? `applied: ${applied.join(', ')}` : 'database is up to date');
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
