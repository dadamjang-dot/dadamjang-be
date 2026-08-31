import { FoAccountWorker } from "./fo-account.worker";

const deferred = <T>() => {
  let reject!: (reason?: unknown) => void;
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
};

describe("FoAccountWorker", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("runs immediately and every 60 seconds only when explicitly enabled", async () => {
    jest.useFakeTimers();
    const anonymizeDueBatch = jest.fn().mockResolvedValue([]);
    const worker = new FoAccountWorker(
      { anonymizeDueBatch } as never,
      { get: jest.fn().mockReturnValue("true") } as never,
    );

    worker.onModuleInit();
    await Promise.resolve();
    expect(anonymizeDueBatch).toHaveBeenCalledTimes(1);
    expect(anonymizeDueBatch).toHaveBeenLastCalledWith(100);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(anonymizeDueBatch).toHaveBeenCalledTimes(2);

    await worker.onApplicationShutdown();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(anonymizeDueBatch).toHaveBeenCalledTimes(2);
  });

  it.each([undefined, "false", "TRUE"])("stays disabled for %s", async (enabled) => {
    jest.useFakeTimers();
    const anonymizeDueBatch = jest.fn().mockResolvedValue([]);
    const worker = new FoAccountWorker(
      { anonymizeDueBatch } as never,
      { get: jest.fn().mockReturnValue(enabled) } as never,
    );

    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(60_000);

    expect(anonymizeDueBatch).not.toHaveBeenCalled();
  });

  it("does not start another scheduled run while one is in flight", async () => {
    jest.useFakeTimers();
    const firstRun = deferred<string[]>();
    const anonymizeDueBatch = jest.fn().mockReturnValueOnce(firstRun.promise).mockResolvedValue([]);
    const worker = new FoAccountWorker(
      { anonymizeDueBatch } as never,
      { get: jest.fn().mockReturnValue("true") } as never,
    );

    worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(180_000);
    const callsWhilePending = anonymizeDueBatch.mock.calls.length;
    firstRun.resolve([]);
    await firstRun.promise;
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60_000);
    const callsAfterResolution = anonymizeDueBatch.mock.calls.length;
    await worker.onApplicationShutdown();

    expect(callsWhilePending).toBe(1);
    expect(callsAfterResolution).toBe(2);
  });

  it("logs a rejected scheduled run and retries on a later tick", async () => {
    jest.useFakeTimers();
    const error = new Error("scheduled anonymization failed");
    const anonymizeDueBatch = jest.fn().mockRejectedValueOnce(error).mockResolvedValue([]);
    const worker = new FoAccountWorker(
      { anonymizeDueBatch } as never,
      { get: jest.fn().mockReturnValue("true") } as never,
    );
    const logger = jest
      .spyOn((worker as never as { logger: { error: (message: string) => void } }).logger, "error")
      .mockImplementation(() => undefined);

    worker.onModuleInit();
    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(60_000);
    await worker.onApplicationShutdown();

    expect(logger).toHaveBeenCalledWith(error.message);
    expect(anonymizeDueBatch).toHaveBeenCalledTimes(2);
  });

  it("clears the timer and waits for an in-flight run during shutdown", async () => {
    jest.useFakeTimers();
    const firstRun = deferred<string[]>();
    const anonymizeDueBatch = jest.fn().mockReturnValue(firstRun.promise);
    const worker = new FoAccountWorker(
      { anonymizeDueBatch } as never,
      { get: jest.fn().mockReturnValue("true") } as never,
    );
    let shutdownSettled = false;

    worker.onModuleInit();
    const shutdown = Promise.resolve(worker.onApplicationShutdown()).then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();
    const settledWhilePending = shutdownSettled;
    await jest.advanceTimersByTimeAsync(180_000);
    firstRun.resolve([]);
    await shutdown;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(settledWhilePending).toBe(false);
    expect(shutdownSettled).toBe(true);
    expect(anonymizeDueBatch).toHaveBeenCalledTimes(1);
  });
});
