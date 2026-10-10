import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule, type AppDeps } from '../../app.module.js';

/** Dựng ứng dụng Nest + Fastify, chưa `listen`. `rawBody` bật để webhook kiểm chữ ký trên byte gốc. */
export async function createApp(deps: AppDeps): Promise<NestFastifyApplication> {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(deps),
    new FastifyAdapter(),
    { rawBody: true, logger: false },
  );
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
