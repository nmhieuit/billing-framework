import pino from 'pino';
import { getCorrelationId } from './correlation.js';

export function createLogger(service: string, destination?: NodeJS.WritableStream): pino.Logger {
  const options: pino.LoggerOptions = {
    base: { service },
    mixin: () => {
      const correlationId = getCorrelationId();
      return correlationId ? { correlationId } : {};
    },
  };
  return destination ? pino(options, destination) : pino(options);
}
