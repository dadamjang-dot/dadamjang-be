import { Injectable, Logger, type OnApplicationShutdown, type OnModuleInit } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { FoAccountRepository } from "./fo-account.repository";

@Injectable()
export class FoAccountWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(FoAccountWorker.name);
  private timer?: NodeJS.Timeout;

  constructor(
    private readonly repository: FoAccountRepository,
    private readonly configService: ConfigService,
  ) {}

  onModuleInit = () => {
    if (this.configService.get<string>("FO_ACCOUNT_ANONYMIZATION_WORKER_ENABLED") !== "true") return;
    this.timer = setInterval(this.runScheduled, 60_000);
    this.timer.unref();
    this.runScheduled();
  };

  onApplicationShutdown = () => {
    if (this.timer) clearInterval(this.timer);
  };

  runOnce = async () => this.repository.anonymizeDueBatch(100);

  private runScheduled = () => {
    void this.runOnce().catch((error: unknown) =>
      this.logger.error(error instanceof Error ? error.message : "FO account anonymization failed"),
    );
  };
}
