import { createLogger } from '@billing/observability';
import { buildApp } from './interface/http/app.js';

const log = createLogger('payment');
const port = Number(process.env.PORT ?? 3002);

const app = await buildApp();
await app.listen({ port, host: '0.0.0.0' });
log.info({ port }, 'payment service listening');
