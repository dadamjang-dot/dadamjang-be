import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { rootCertificates } from "tls";
import { createDatabasePool, databasePoolConfig } from "./connection";

const baseEnv = (nodeEnv: string | undefined = "development"): NodeJS.ProcessEnv => ({
  ...(nodeEnv === undefined ? {} : { NODE_ENV: nodeEnv }),
  POSTGRES_HOST: "database.example.test",
  POSTGRES_PORT: "5432",
  POSTGRES_USERNAME: "postgres",
  POSTGRES_PASSWORD: "secret",
  POSTGRES_DATABASE: "dadamjang",
});

describe("databasePoolConfig", () => {
  it.each([undefined, "local", "development", "test"])("keeps %s connections non-TLS", (nodeEnv) => {
    expect(databasePoolConfig(baseEnv(nodeEnv)).ssl).toBeUndefined();
  });

  it.each(["production", "e2e", "staging"])("requires TLS in %s", (nodeEnv) => {
    expect(() => databasePoolConfig(baseEnv(nodeEnv))).toThrow("POSTGRES_SSL=true");
  });

  it("loads a valid built-in root CA with certificate verification in non-local environments", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dadamjang-postgres-"));
    const caPath = path.join(directory, "global-bundle.pem");
    const ca = Buffer.from(rootCertificates[0] ?? "");
    writeFileSync(caPath, ca);

    try {
      const env = {
        ...baseEnv("production"),
        POSTGRES_SSL: "true",
        POSTGRES_SSL_CA_PATH: caPath,
      };
      const config = databasePoolConfig(env);
      const pool = createDatabasePool(env);

      expect(config.ssl).toEqual({ rejectUnauthorized: true, ca });
      expect(pool.options.ssl).toEqual({ rejectUnauthorized: true, ca });
      await pool.end();
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each([
    ["missing CA path", undefined],
    ["unreadable CA path", "/does/not/exist/global-bundle.pem"],
  ])("rejects a %s", (_caseName, caPath) => {
    const env = {
      ...baseEnv("production"),
      POSTGRES_SSL: "true",
      ...(caPath === undefined ? {} : { POSTGRES_SSL_CA_PATH: caPath }),
    };

    expect(() => databasePoolConfig(env)).toThrow("POSTGRES_SSL_CA_PATH");
  });

  it("rejects an empty CA bundle", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dadamjang-postgres-"));
    const caPath = path.join(directory, "global-bundle.pem");
    writeFileSync(caPath, "");

    try {
      expect(() =>
        databasePoolConfig({
          ...baseEnv("production"),
          POSTGRES_SSL: "true",
          POSTGRES_SSL_CA_PATH: caPath,
        }),
      ).toThrow("nonempty");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it("rejects malformed CA content", () => {
    const directory = mkdtempSync(path.join(tmpdir(), "dadamjang-postgres-"));
    const caPath = path.join(directory, "global-bundle.pem");
    writeFileSync(caPath, "not a certificate");

    try {
      expect(() =>
        databasePoolConfig({
          ...baseEnv("production"),
          POSTGRES_SSL: "true",
          POSTGRES_SSL_CA_PATH: caPath,
        }),
      ).toThrow("valid CA");
    } finally {
      rmSync(directory, { recursive: true });
    }
  });

  it.each(["POSTGRES_HOST", "POSTGRES_USERNAME", "POSTGRES_PASSWORD", "POSTGRES_DATABASE"])("requires %s", (name) => {
    const env = baseEnv();
    delete env[name];

    expect(() => databasePoolConfig(env)).toThrow(`${name} is required`);
  });

  it.each(["", "0", "65536", "5432.5", "not-a-port"])("rejects invalid port %j", (port) => {
    expect(() => databasePoolConfig({ ...baseEnv(), POSTGRES_PORT: port })).toThrow("POSTGRES_PORT");
  });

  it("defaults the local port to 5432", () => {
    const env = baseEnv();
    delete env.POSTGRES_PORT;

    expect(databasePoolConfig(env).port).toBe(5432);
  });

  it("bounds shared pool connections without globally bounding application queries", async () => {
    const config = databasePoolConfig(baseEnv());
    const pool = createDatabasePool(baseEnv());

    expect(config.connectionTimeoutMillis).toBe(3000);
    expect(config).not.toHaveProperty("query_timeout");
    expect(pool.options.connectionTimeoutMillis).toBe(3000);
    expect(pool.options).not.toHaveProperty("query_timeout");
    await pool.end();
  });

  it("keeps scoped connection options on the shared pool path", async () => {
    const pool = createDatabasePool(baseEnv(), "-c search_path=scoped,public");

    expect(pool.options.options).toBe("-c search_path=scoped,public");
    await pool.end();
  });
});
