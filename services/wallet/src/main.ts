import 'reflect-metadata';
import { ConfigError } from '@billing/database';
import { createLogger } from '@billing/observability';
import { createShutdownHandler, startOrExit } from '@billing/runtime';
import { startService } from './bootstrap.js';
import { loadConfig, type WalletConfig } from './config.js';

const log = createLogger('wallet');

let config: WalletConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    log.error({ problems: error.problems }, 'invalid configuration, refusing to start');
    process.exit(1);
  }
  throw error;
}

const service = await startOrExit({
  start: () => startService(config),
  listen: (running) => running.app.listen(config.port, '0.0.0.0').then(() => {}),
  log,
  exit: (code) => process.exit(code),
});
if (!service) process.exit(1);
log.info(
  { port: config.port, tenants: config.tenants.map((t) => t.value) },
  'wallet service listening',
);

const shutdown = createShutdownHandler({
  stop: () => service.stop(),
  log,
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
