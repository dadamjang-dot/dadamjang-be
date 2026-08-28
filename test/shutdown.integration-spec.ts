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

const waitForExit = (child: ChildProcess, output: { value: string }) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for exit: ${output.value}`)), 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

describe("service shutdown", () => {
  it.each(["SIGTERM", "SIGINT"] as const)(
    "awaits DatabasePool.end on %s",
    async (signal) => {
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
        child.kill(signal);
        const exit = await waitForExit(child, output);

        expect(output.value).toContain("database-pool-ended");
        expect(exit).toEqual({ code: null, signal });
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
    },
    10_000,
  );
});
