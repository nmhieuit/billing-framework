import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import { RabbitMQContainer } from '@testcontainers/rabbitmq';
import type { TestProject } from 'vitest/node';
import './provided-context.js';

const SA_PASSWORD = 'Str0ng!Passw0rd';

/**
 * Khởi động SQL Server 2022 và RabbitMQ 3 song song, dùng chung cho cả lượt chạy integration. Mỗi test file tự tạo
 * DB riêng (`createTestDatabase`) hoặc vhost riêng (`createTestBroker`). RabbitMQ có thể khởi động chậm: timeout 120 s.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [sql, rabbit] = await Promise.allSettled([
    new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
      .acceptLicense()
      .withPassword(SA_PASSWORD)
      .start(),
    new RabbitMQContainer('rabbitmq:3-management-alpine').withStartupTimeout(120_000).start(),
  ]);

  const stopAll = async (): Promise<void> => {
    await Promise.allSettled([
      sql.status === 'fulfilled' ? sql.value.stop() : undefined,
      rabbit.status === 'fulfilled' ? rabbit.value.stop() : undefined,
    ]);
  };
  if (sql.status === 'rejected' || rabbit.status === 'rejected') {
    await stopAll();
    throw sql.status === 'rejected' ? sql.reason : (rabbit as PromiseRejectedResult).reason;
  }

  project.provide('sqlServer', {
    host: sql.value.getHost(),
    port: sql.value.getPort(),
    user: sql.value.getUsername(),
    password: sql.value.getPassword(),
  });
  project.provide('rabbitmq', {
    host: rabbit.value.getHost(),
    amqpPort: rabbit.value.getMappedPort(5672),
    managementPort: rabbit.value.getMappedPort(15672),
    adminUser: 'guest',
    adminPassword: 'guest',
  });

  return stopAll;
}
