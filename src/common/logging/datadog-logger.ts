import { LoggerService } from "@nestjs/common";

type LogLevel = "debug" | "error" | "log" | "verbose" | "warn";

export class DatadogLogger implements LoggerService {
  private readonly service = process.env.DD_SERVICE ?? "dadamjang-be";
  private readonly env = process.env.DD_ENV ?? process.env.NODE_ENV ?? "development";
  private readonly version = process.env.DD_VERSION;

  log = (message: unknown, context?: string) => {
    this.write("log", message, context);
  };

  error = (message: unknown, trace?: string, context?: string) => {
    this.write("error", message, context, trace);
  };

  warn = (message: unknown, context?: string) => {
    this.write("warn", message, context);
  };

  debug = (message: unknown, context?: string) => {
    this.write("debug", message, context);
  };

  verbose = (message: unknown, context?: string) => {
    this.write("verbose", message, context);
  };

  private write = (level: LogLevel, message: unknown, context?: string, trace?: string) => {
    const payload = {
      timestamp: new Date().toISOString(),
      level: level === "log" ? "info" : level,
      service: this.service,
      dd: {
        service: this.service,
        env: this.env,
        version: this.version,
      },
      context,
      ...this.parseMessage(message),
      ...(trace ? { error: { stack: trace } } : {}),
    };

    const line = JSON.stringify(payload);
    if (level === "error" || level === "warn") {
      process.stderr.write(`${line}\n`);
      return;
    }
    process.stdout.write(`${line}\n`);
  };

  private parseMessage = (message: unknown) => {
    if (typeof message !== "string") return { message };

    try {
      const parsed = JSON.parse(message) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      return { message };
    }

    return { message };
  };
}
