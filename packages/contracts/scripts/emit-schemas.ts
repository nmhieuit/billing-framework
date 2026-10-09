import { emitSchemas } from '../src/emit.js';

const dir = process.argv[2];
if (!dir) {
  console.error('usage: emit-schemas <output-dir>');
  process.exit(1);
}
const written = await emitSchemas(dir);
console.log(`wrote ${written.length} schema files to ${dir}`);
