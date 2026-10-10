import { sql, type Kysely } from 'kysely';

/** Metadata do bên gọi gửi kèm charge (chuỗi JSON); null khi không có. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table charges add metadata nvarchar(max) null`.execute(db);
}
