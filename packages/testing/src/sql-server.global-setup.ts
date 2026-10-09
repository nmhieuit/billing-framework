import { MSSQLServerContainer } from '@testcontainers/mssqlserver';
import type { TestProject } from 'vitest/node';
import './provided-context.js';

const SA_PASSWORD = 'Str0ng!Passw0rd';

/** Khởi động một SQL Server 2022 dùng chung cho cả lượt chạy integration; mỗi test file tự tạo DB riêng. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const container = await new MSSQLServerContainer('mcr.microsoft.com/mssql/server:2022-latest')
    .acceptLicense()
    .withPassword(SA_PASSWORD)
    .start();

  project.provide('sqlServer', {
    host: container.getHost(),
    port: container.getPort(),
    user: container.getUsername(),
    password: container.getPassword(),
  });

  return async () => {
    await container.stop();
  };
}
