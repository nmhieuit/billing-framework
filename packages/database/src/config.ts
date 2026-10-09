export interface DatabaseConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax?: number;
  encrypt?: boolean;
  trustServerCertificate?: boolean;
}

export class ConfigError extends Error {
  override name = 'ConfigError';

  constructor(readonly problems: string[]) {
    super(`Invalid configuration: ${problems.join('; ')}`);
  }
}

export function databaseConfigFromEnv(prefix: string, env: NodeJS.ProcessEnv): DatabaseConfig {
  const problems: string[] = [];

  const required = (suffix: string): string => {
    const name = `${prefix}_${suffix}`;
    const value = env[name];
    if (value === undefined || value.trim() === '') {
      problems.push(`${name} is required`);
      return '';
    }
    return value;
  };

  const host = required('HOST');
  const database = required('NAME');
  const user = required('USER');
  const password = required('PASSWORD');

  let port = 1433;
  const rawPort = env[`${prefix}_PORT`];
  if (rawPort !== undefined && rawPort.trim() !== '') {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      problems.push(`${prefix}_PORT must be an integer in 1..65535`);
    } else {
      port = parsed;
    }
  }

  if (problems.length > 0) throw new ConfigError(problems);
  return { host, port, database, user, password };
}
