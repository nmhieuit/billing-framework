import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { envelopeSchema } from './envelope.js';
import { eventSchemas } from './events.js';

/** Ghi JSON Schema thành file để team ecommerce (C#) lấy làm hợp đồng. */
export async function emitSchemas(dir: string): Promise<string[]> {
  await mkdir(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ['envelope.v1.json', envelopeSchema],
    ...Object.entries(eventSchemas).map(
      ([type, schema]): [string, unknown] => [`${type}.json`, schema],
    ),
  ];
  const written: string[] = [];
  for (const [name, schema] of files) {
    const path = join(dir, name);
    await writeFile(path, `${JSON.stringify(schema, null, 2)}\n`, 'utf8');
    written.push(path);
  }
  return written;
}
