export interface SqlServerConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

export interface RabbitMqConnection {
  host: string;
  amqpPort: number;
  managementPort: number;
  adminUser: string;
  adminPassword: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    sqlServer: SqlServerConnection;
    rabbitmq: RabbitMqConnection;
  }
}
