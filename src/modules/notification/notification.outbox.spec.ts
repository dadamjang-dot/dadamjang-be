import type { ConfigService } from "@nestjs/config";
import { NotificationOutboxWorker } from "./notification.outbox";
import { NotificationRepository } from "./notification.repository";
import { ExpoPushSender, PermanentPushError, RetryablePushError } from "./notification.sender";

const claimedSend = {
  pushOutboxId: "82000000-0000-4000-8000-000000000001",
  notificationId: "81000000-0000-4000-8000-000000000001",
  pushDeviceId: "83000000-0000-4000-8000-000000000001",
  claimToken: "84000000-0000-4000-8000-000000000001",
  attemptCount: 1,
  expoPushToken: "ExponentPushToken[worker-token]",
  type: "ORDER_STATUS" as const,
  title: "결제가 완료됐어요",
  body: "주문 상품을 준비할게요.",
  entityId: "90000000-0000-4000-8000-000000000001",
};

const claimedReceipt = {
  ...claimedSend,
  claimToken: "84000000-0000-4000-8000-000000000002",
  expoTicketId: "ticket-1",
};

const setup = (input?: {
  sendError?: Error;
  receiptError?: Error;
  persistTicketError?: Error;
  retryError?: Error;
  enabled?: string;
}) => {
  const repository = {
    purgeTerminalPushDeliveries: jest.fn().mockResolvedValue(0),
    claimPushSendBatch: jest.fn().mockResolvedValue([claimedSend]),
    persistPushTickets: input?.persistTicketError
      ? jest.fn().mockRejectedValue(input.persistTicketError)
      : jest.fn().mockResolvedValue(undefined),
    retryPushClaims: input?.retryError
      ? jest.fn().mockRejectedValue(input.retryError)
      : jest.fn().mockResolvedValue(undefined),
    failPushClaims: jest.fn().mockResolvedValue(undefined),
    claimPushReceiptBatch: jest.fn().mockResolvedValue([claimedReceipt]),
    persistPushReceipts: jest.fn().mockResolvedValue(undefined),
  };
  const sender = {
    send: input?.sendError
      ? jest.fn().mockRejectedValue(input.sendError)
      : jest.fn().mockResolvedValue([{ status: "ok", id: "ticket-1" }]),
    getReceipts: input?.receiptError
      ? jest.fn().mockRejectedValue(input.receiptError)
      : jest.fn().mockResolvedValue({ "ticket-1": { status: "ok" } }),
  };
  const config = {
    get: jest.fn((key: string) => (key === "PUSH_OUTBOX_WORKER_ENABLED" ? input?.enabled : undefined)),
  };
  const worker = new NotificationOutboxWorker(
    repository as unknown as NotificationRepository,
    config as unknown as ConfigService,
    sender as unknown as ExpoPushSender,
  );
  return { config, repository, sender, worker };
};

describe("NotificationOutboxWorker", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("claims bounded send and receipt batches and persists provider results", async () => {
    const now = new Date("2026-08-31T02:00:00.000Z");
    const { repository, sender, worker } = setup();

    await expect(worker.runOnce(now)).resolves.toBe(true);

    expect(repository.purgeTerminalPushDeliveries).toHaveBeenCalledWith(now);
    expect(repository.claimPushSendBatch).toHaveBeenCalledWith(now, 100);
    expect(sender.send).toHaveBeenCalledWith([
      {
        to: claimedSend.expoPushToken,
        title: claimedSend.title,
        body: claimedSend.body,
        data: {
          notificationId: claimedSend.notificationId,
          type: claimedSend.type,
          entityId: claimedSend.entityId,
        },
      },
    ]);
    expect(repository.persistPushTickets).toHaveBeenCalledWith([claimedSend], [{ status: "ok", id: "ticket-1" }], now);
    expect(repository.claimPushReceiptBatch).toHaveBeenCalledWith(now, 1_000);
    expect(sender.getReceipts).toHaveBeenCalledWith(["ticket-1"]);
    expect(repository.persistPushReceipts).toHaveBeenCalledWith(
      [claimedReceipt],
      { "ticket-1": { status: "ok" } },
      now,
    );
  });

  it("requeues retryable failures and terminally fails permanent failures", async () => {
    const now = new Date("2026-08-31T02:00:00.000Z");
    const retryable = setup({ sendError: new RetryablePushError(503) });
    retryable.repository.claimPushReceiptBatch.mockResolvedValue([]);
    await retryable.worker.runOnce(now);
    expect(retryable.repository.retryPushClaims).toHaveBeenCalledWith([claimedSend], expect.any(Error), now);
    expect(retryable.repository.failPushClaims).not.toHaveBeenCalled();

    const permanent = setup({ receiptError: new PermanentPushError(400) });
    permanent.repository.claimPushSendBatch.mockResolvedValue([]);
    await permanent.worker.runOnce(now);
    expect(permanent.repository.failPushClaims).toHaveBeenCalledWith([claimedReceipt], expect.any(Error), now);
    expect(permanent.repository.retryPushClaims).not.toHaveBeenCalled();
  });

  it("treats a concurrently invalidated claim as already settled", async () => {
    const claimLost = new Error("Push delivery claim was lost");
    const { repository, worker } = setup({ persistTicketError: claimLost, retryError: claimLost });
    repository.claimPushReceiptBatch.mockResolvedValue([]);

    await expect(worker.runOnce(new Date("2026-08-31T02:00:00.000Z"))).resolves.toBe(true);
  });

  it("keeps the worker disabled unless the feature flag is exactly true", async () => {
    jest.useFakeTimers();
    const disabled = setup();
    const disabledRun = jest.spyOn(disabled.worker, "runOnce");
    disabled.worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(2_000);
    expect(disabledRun).not.toHaveBeenCalled();

    const enabled = setup({ enabled: "true" });
    const enabledRun = jest.spyOn(enabled.worker, "runOnce").mockResolvedValue(false);
    enabled.worker.onModuleInit();
    await jest.advanceTimersByTimeAsync(1_000);
    expect(enabledRun).toHaveBeenCalledTimes(1);
    enabled.worker.onApplicationShutdown();
  });

  it("does not overlap one-second ticks", async () => {
    jest.useFakeTimers();
    const { worker } = setup({ enabled: "true" });
    let release: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const run = jest.spyOn(worker, "runOnce").mockImplementation(async () => pending.then(() => false));
    worker.onModuleInit();

    await jest.advanceTimersByTimeAsync(3_000);
    expect(run).toHaveBeenCalledTimes(1);
    release?.();
    await pending;
    worker.onApplicationShutdown();
  });
});
