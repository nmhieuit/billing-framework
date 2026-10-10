import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { eventCatalog } from './events.js';
import { chargeWebhookSchema } from './webhook.js';

/** Ghi JSON Schema thành file để các bên (kể cả team ecommerce, C#) lấy làm hợp đồng. */
export async function emitSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ['payment.charge-event.v1.json', chargeWebhookSchema],
    ...Object.values(eventCatalog).map((entry): [string, unknown] => [
      entry.schemaFile,
      entry.schema,
    ]),
  ];
  const written: string[] = [];
  for (const [name, schema] of files) {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    written.push(path);
  }
  return written;
}
