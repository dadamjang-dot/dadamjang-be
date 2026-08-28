import { spawn, type ChildProcess } from "child_process";

const waitForOutput = (child: ChildProcess, output: { value: string }, expected: string) =>
  new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${expected}: ${output.value}`)), 15_000);
    const inspect = () => {
      if (!output.value.includes(expected)) return;
      clearTimeout(timeout);
      resolve();
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`Shutdown app exited before ${expected}: code=${code} signal=${signal} ${output.value}`));
    });
  });

const waitForExit = (child: ChildProcess) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });

describe("service shutdown", () => {
  it("invokes DatabasePool.onApplicationShutdown on SIGTERM", async () => {
    const child = spawn(
      process.execPath,
      ["-r", "ts-node/register", "-r", "tsconfig-paths/register", "test/support/shutdown-app.ts"],
      { cwd: process.cwd(), env: process.env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const output = { value: "" };
    child.stdout?.on("data", (chunk: Buffer) => {
      output.value += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      output.value += chunk.toString();
    });

    try {
      await waitForOutput(child, output, "shutdown-ready");
      child.kill("SIGTERM");
      const exit = await waitForExit(child);

      expect(output.value).toContain("database-pool-shutdown:SIGTERM");
      expect(exit).toEqual({ code: null, signal: "SIGTERM" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 20_000);
});
