import { Pool } from "pg";

type DatabaseMode = "test" | "e2e";

const databaseNames = {
  test: "dadamjang_test",
  e2e: "dadamjang_e2e",
} as const;

export const assertDatabaseMode = (mode: DatabaseMode) => {
  const expectedEnvironment = mode;
  const expectedDatabase = databaseNames[mode];
  if (process.env.NODE_ENV !== expectedEnvironment || process.env.POSTGRES_DATABASE !== expectedDatabase) {
    throw new Error(
      `Refusing ${mode} database reset: require NODE_ENV=${expectedEnvironment} and POSTGRES_DATABASE=${expectedDatabase}`,
    );
  }
};

export const createDatabasePool = () =>
  new Pool({
    host: process.env.POSTGRES_HOST,
    port: Number(process.env.POSTGRES_PORT ?? 5432),
    user: process.env.POSTGRES_USERNAME,
    password: process.env.POSTGRES_PASSWORD,
    database: process.env.POSTGRES_DATABASE,
  });
