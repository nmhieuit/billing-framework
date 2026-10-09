export interface SqlServerConnection {
  host: string;
  port: number;
  user: string;
  password: string;
}

declare module 'vitest' {
  export interface ProvidedContext {
    sqlServer: SqlServerConnection;
  }
}
