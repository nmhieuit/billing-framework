import { createLogger } from '@billing/observability';

createLogger('wallet').error({}, 'wallet is not wired yet; see bootstrap.ts (next task)');
process.exit(1);
