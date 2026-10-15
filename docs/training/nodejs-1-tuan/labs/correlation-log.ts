// Bài lab Ngày 6. Chạy: node_modules/.bin/tsx docs/training/nodejs-1-tuan/labs/correlation-log.ts
// Quan sát: dòng log trong runWithCorrelation tự có "correlationId", dòng ngoài thì không.
import { createLogger, runWithCorrelation } from '../../../../packages/observability/src/index.js';

const log = createLogger('lab');
log.info('ngoài phạm vi correlation');
await runWithCorrelation('11111111-1111-4111-8111-111111111111', async () => {
  log.info('trong phạm vi, trước await');
  await new Promise((resolve) => setTimeout(resolve, 5));
  log.info('trong phạm vi, sau await');
});
