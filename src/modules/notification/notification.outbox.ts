import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { NotificationRepository } from "./notification.repository";
import { ExpoPushSender, PermanentPushError } from "./notification.sender";

const pushClaimWasLost = (error: unknown) => error instanceof Error && error.message === "Push delivery claim was lost";

@Injectable()
export class NotificationOutboxWorker implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private readonly logger = new Logger(NotificationOutboxWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: NotificationRepository,
    private readonly configService: ConfigService,
    private readonly sender: ExpoPushSender,
  ) {}

  onModuleInit = () => {
    if (this.configService.get<string>("PUSH_OUTBOX_WORKER_ENABLED") !== "true") return;
    this.timer = setInterval(() => void this.tick(), 1_000);
    this.timer.unref();
  };

  onApplicationShutdown = () => {
    if (this.timer) clearInterval(this.timer);
  };

  runOnce = async (now = new Date()) => {
    let handled = (await this.repository.purgeTerminalPushDeliveries(now)) > 0;
    const sends = await this.repository.claimPushSendBatch(now, 100);
    if (sends.length) {
      handled = true;
      try {
        const tickets = await this.sender.send(
          sends.map(({ expoPushToken, notificationId, type, title, body, entityId }) => ({
            to: expoPushToken,
            title,
            body,
            data: { notificationId, type, entityId },
          })),
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
        const results = await this.sender.getReceipts(receipts.map(({ expoTicketId }) => expoTicketId));
        await this.repository.persistPushReceipts(receipts, results, now);
      } catch (error) {
        await this.settleFailure(receipts, error, now);
      }
    }
    return handled;
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

  private tick = async () => {
    if (this.running) return;
    this.running = true;
    try {
      await this.runOnce();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : "Push Outbox delivery failed");
    } finally {
      this.running = false;
    }
  };
}
