import { ConfigError, createDatabase, databaseConfigFromEnv, migrate } from '@billing/database';
import { paymentMigrations } from './migrations.js';

try {
  const config = databaseConfigFromEnv('PAYMENT_DB', process.env);
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
