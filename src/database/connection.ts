import type { OnApplicationShutdown } from "@nestjs/common";
import { readFileSync } from "fs";
import { Pool, type PoolConfig } from "pg";
import { createSecureContext } from "tls";

type DatabaseMode = "test" | "e2e";

const databaseNames = {
  test: "dadamjang_test",
  e2e: "dadamjang_e2e",
} as const;

const localEnvironments = new Set(["local", "development", "test"]);

const requiredEnv = (env: NodeJS.ProcessEnv, name: string) => {
  const value = env[name];
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value;
};

const databasePort = (value: string | undefined) => {
  const port = value ?? "5432";
  if (!/^\d+$/.test(port) || !Number.isInteger(Number(port)) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("POSTGRES_PORT must be an integer between 1 and 65535");
  return Number(port);
};

const databaseSsl = (env: NodeJS.ProcessEnv) => {
  const environment = env.NODE_ENV ?? "development";
  if (localEnvironments.has(environment)) return undefined;
  if (env.POSTGRES_SSL !== "true") throw new Error("POSTGRES_SSL=true is required outside local environments");
  const caPath = requiredEnv(env, "POSTGRES_SSL_CA_PATH");
  let ca: Buffer;
  try {
    ca = readFileSync(caPath);
  } catch {
    throw new Error("POSTGRES_SSL_CA_PATH must point to a readable nonempty valid CA bundle");
  }
  if (!ca.length) throw new Error("POSTGRES_SSL_CA_PATH must point to a readable nonempty valid CA bundle");
  try {
    createSecureContext({ ca, cert: ca });
  } catch {
    throw new Error("POSTGRES_SSL_CA_PATH must point to a readable nonempty valid CA bundle");
  }
  return { rejectUnauthorized: true, ca };
};

export const databasePoolConfig = (env: NodeJS.ProcessEnv = process.env): PoolConfig => {
  const ssl = databaseSsl(env);
  return {
    host: requiredEnv(env, "POSTGRES_HOST"),
    port: databasePort(env.POSTGRES_PORT),
    user: requiredEnv(env, "POSTGRES_USERNAME"),
    password: requiredEnv(env, "POSTGRES_PASSWORD"),
    database: requiredEnv(env, "POSTGRES_DATABASE"),
    connectionTimeoutMillis: 3000,
    ...(ssl === undefined ? {} : { ssl }),
  };
};

export class DatabasePool extends Pool implements OnApplicationShutdown {
  onApplicationShutdown = async () => {
    await this.end();
  };
}

export const assertDatabaseMode = (mode: DatabaseMode) => {
  const expectedEnvironment = mode;
  const expectedDatabase = databaseNames[mode];
  if (process.env.NODE_ENV !== expectedEnvironment || process.env.POSTGRES_DATABASE !== expectedDatabase) {
    throw new Error(
      `Refusing ${mode} database reset: require NODE_ENV=${expectedEnvironment} and POSTGRES_DATABASE=${expectedDatabase}`,
    );
  }
};

export const createDatabasePool = (env: NodeJS.ProcessEnv = process.env, options?: string) =>
  new DatabasePool({ ...databasePoolConfig(env), ...(options === undefined ? {} : { options }) });
