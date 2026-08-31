import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationRepository } from "./notification.repository";
import { ExpoPushSender, PermanentPushError } from "./notification.sender";

const pushClaimWasLost = (error: unknown) => error instanceof Error && error.message === "Push delivery claim was lost";
const CLAIM_HEARTBEAT_MS = 10_000;

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnApplicationShutdown {
  private activeTick: Promise<void> | undefined;
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private stopping = false;
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly configService: ConfigService,
    private readonly sender: ExpoPushSender,
  ) {}

  onModuleInit = () => {
    if (this.stopping || this.configService.get<string>("PUSH_OUTBOX_WORKER_ENABLED") !== "true") return;
    this.timer = setInterval(this.startTick, 1_000);
    this.timer.unref();
  };

  onApplicationShutdown = async () => {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.activeTick;
  };

  runOnce = async (now = new Date()) => {
    let handled = (await this.repository.purgeTerminalPushDeliveries(now)) > 0;
    const sends = await this.repository.claimPushSendBatch(now, 100);
    if (sends.length) {
      handled = true;
      try {
        const tickets = await this.withClaimHeartbeat(sends, () =>
          this.sender.send(
            sends.map(({ expoPushToken, notificationId, type, title, body, entityId }) => ({
              to: expoPushToken,
              title,
              body,
              data: { notificationId, type, entityId },
            })),
          ),
        );
        await this.repository.persistPushTickets(sends, tickets, now);
      } catch (error) {
        await this.settleFailure(sends, error, now);
      }
    }
    const receipts = await this.repository.claimPushReceiptBatch(now, 1_000);
    if (receipts.length) {
      handled = true;
      try {
        const results = await this.withClaimHeartbeat(receipts, () =>
          this.sender.getReceipts(receipts.map(({ expoTicketId }) => expoTicketId)),
        );
        await this.repository.persistPushReceipts(receipts, results, now);
      } catch (error) {
        await this.settleFailure(receipts, error, now);
      }
    }
    return handled;
  };

  private withClaimHeartbeat = async <T>(
    claims: Parameters<NotificationRepository["renewPushClaims"]>[0],
    operation: () => Promise<T>,
  ): Promise<T> => {
    let heartbeatError: unknown;
    let operationError: unknown;
    let result: T | undefined;
    let renewal = Promise.resolve();
    const renew = () => {
      renewal = renewal
        .then(() => (heartbeatError ? undefined : this.repository.renewPushClaims(claims, new Date())))
        .catch((error: unknown) => {
          heartbeatError = error;
        });
    };
    const timer = setInterval(renew, CLAIM_HEARTBEAT_MS);
    timer.unref();
    try {
      result = await operation();
    } catch (error) {
      operationError = error;
    } finally {
      clearInterval(timer);
    }
    await renewal;
    if (operationError) throw heartbeatError ?? operationError;
    return result as T;
  };

  private settleFailure = async (
    claims: Parameters<NotificationRepository["retryPushClaims"]>[0],
    error: unknown,
    now: Date,
  ) => {
    if (pushClaimWasLost(error)) return;
    try {
      if (error instanceof PermanentPushError) await this.repository.failPushClaims(claims, error, now);
      else await this.repository.retryPushClaims(claims, error, now);
    } catch (settlementError) {
      if (!pushClaimWasLost(settlementError)) throw settlementError;
    }
  };

  private startTick = () => {
    if (this.stopping || this.activeTick) return;
    const tick = this.tick();
    this.activeTick = tick;
    void tick.finally(() => {
      if (this.activeTick === tick) this.activeTick = undefined;
    });
  };

  private tick = async () => {
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : "Push Outbox delivery failed");
    }
  };
}
