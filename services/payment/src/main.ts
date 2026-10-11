import { ConfigError } from '@billing/database';
import { createLogger, initTelemetry } from '@billing/observability';
import { createShutdownHandler, startOrExit } from '@billing/runtime';
import { startService } from './bootstrap.js';
import { loadConfig, type PaymentConfig } from './config.js';
import { OtelPaymentMetrics } from './infrastructure/otel-metrics.js';

const log = createLogger('payment');

let config: PaymentConfig;
try {
  config = loadConfig(process.env);
} catch (error) {
  if (error instanceof ConfigError) {
    log.error({ problems: error.problems }, 'invalid configuration, refusing to start');
    process.exit(1);
  }
  throw error;
}

// Không đặt OTEL_EXPORTER_OTLP_ENDPOINT thì telemetry là no-op.
const telemetry = initTelemetry({ serviceName: 'payment' });

const service = await startOrExit({
  start: () => startService(config, { metrics: new OtelPaymentMetrics(telemetry) }),
  listen: (running) => running.app.listen({ port: config.port, host: '0.0.0.0' }).then(() => {}),
  log,
  exit: (code) => process.exit(code),
});
if (!service) process.exit(1);
log.info({ port: config.port }, 'payment service listening');

const shutdown = createShutdownHandler({
  stop: async () => {
    try {
      await service.stop();
    } finally {
      // Luôn thử xả telemetry dù stop() lỗi, nhưng chặn trên 5 giây để không treo khi tắt dịch vụ.
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 5_000);
      });
      try {
        await Promise.race([telemetry.shutdown(), timeout]);
      } finally {
        clearTimeout(timer);
      }
    }
  },
  log,
  exit: (code) => process.exit(code),
});
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
