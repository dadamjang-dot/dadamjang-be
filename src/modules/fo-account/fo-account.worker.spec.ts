import { FoAccountWorker } from "./fo-account.worker";

describe("FoAccountWorker", () => {
  afterEach(() => {
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

    worker.onApplicationShutdown();
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
});
