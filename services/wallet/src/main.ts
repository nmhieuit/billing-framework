import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { createLogger } from '@billing/observability';
import { AppModule } from './app.module.js';

const log = createLogger('wallet');
const port = Number(process.env.PORT ?? 3001);

const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());
await app.listen(port, '0.0.0.0');
log.info({ port }, 'wallet service listening');
