import { type MiddlewareConsumer, Module, type NestModule } from '@nestjs/common';
import { CorrelationMiddleware } from './interface/http/correlation.middleware.js';
import { HealthController } from './interface/http/health.controller.js';

@Module({ controllers: [HealthController] })
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(CorrelationMiddleware).forRoutes('*');
  }
}
