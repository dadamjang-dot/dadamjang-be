import { Injectable } from "@nestjs/common";

type FoNotificationTypeValue = "ORDER_STATUS" | "WISH_PRICE_DROP" | "WISH_RESTOCK" | "STYLE_LIKE";

export type ExpoPushMessage = Readonly<{
  to: string;
  title: string;
  body: string;
  data: Readonly<{ notificationId: string; type: FoNotificationTypeValue; entityId: string }>;
}>;

export type ExpoPushTicket =
  | Readonly<{ status: "ok"; id: string }>
  | Readonly<{ status: "error"; message: string; details?: Readonly<{ error?: string }> }>;

export type ExpoPushReceipt =
  Readonly<{ status: "ok" }> | Readonly<{ status: "error"; message: string; details?: Readonly<{ error?: string }> }>;

export class RetryablePushError extends Error {
  constructor(readonly status?: number) {
    super(status ? `Expo Push retryable HTTP ${status}` : "Expo Push retryable response");
    this.name = RetryablePushError.name;
  }
}

export class PermanentPushError extends Error {
  constructor(readonly status: number) {
    super(`Expo Push permanent HTTP ${status}`);
    this.name = PermanentPushError.name;
  }
}

const SEND_URL = "https://exp.host/--/api/v2/push/send";
const RECEIPT_URL = "https://exp.host/--/api/v2/push/getReceipts";
const SEND_BATCH_SIZE = 100;
const HTTP_ATTEMPTS = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const validDetails = (value: unknown) =>
  value === undefined || (isRecord(value) && (value.error === undefined || typeof value.error === "string"));

const parseTicket = (value: unknown): ExpoPushTicket => {
  if (!isRecord(value)) throw new RetryablePushError();
  if (value.status === "ok" && typeof value.id === "string" && value.id.length > 0)
    return { status: "ok", id: value.id };
  if (
    value.status === "error" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    validDetails(value.details)
  )
    return {
      status: "error",
      message: value.message,
      ...(value.details === undefined ? {} : { details: value.details as Readonly<{ error?: string }> }),
    };
  throw new RetryablePushError();
};

const parseReceipt = (value: unknown): ExpoPushReceipt => {
  if (!isRecord(value)) throw new RetryablePushError();
  if (value.status === "ok") return { status: "ok" };
  if (
    value.status === "error" &&
    typeof value.message === "string" &&
    value.message.length > 0 &&
    validDetails(value.details)
  )
    return {
      status: "error",
      message: value.message,
      ...(value.details === undefined ? {} : { details: value.details as Readonly<{ error?: string }> }),
    };
  throw new RetryablePushError();
};

export const parseExpoPushTickets = (value: unknown, expectedCount: number): readonly ExpoPushTicket[] => {
  if (!isRecord(value) || !Array.isArray(value.data) || value.data.length !== expectedCount)
    throw new RetryablePushError();
  return value.data.map(parseTicket);
};

const parseExpoPushReceipts = (
  value: unknown,
  ticketIds: readonly string[],
): Readonly<Record<string, ExpoPushReceipt>> => {
  if (!isRecord(value) || !isRecord(value.data)) throw new RetryablePushError();
  const data = value.data;
  const responseIds = Object.keys(data);
  if (responseIds.some((ticketId) => !ticketIds.includes(ticketId))) throw new RetryablePushError();
  return Object.fromEntries(responseIds.map((ticketId) => [ticketId, parseReceipt(data[ticketId])])) as Readonly<
    Record<string, ExpoPushReceipt>
  >;
};

const wait = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

@Injectable()
export class ExpoPushSender {
  send = async (messages: readonly ExpoPushMessage[]): Promise<readonly ExpoPushTicket[]> => {
    const tickets: ExpoPushTicket[] = [];
    for (let index = 0; index < messages.length; index += SEND_BATCH_SIZE) {
      const batch = messages.slice(index, index + SEND_BATCH_SIZE);
      tickets.push(...(await this.request(SEND_URL, batch, (value) => parseExpoPushTickets(value, batch.length))));
    }
    return tickets;
  };

  getReceipts = async (ticketIds: readonly string[]): Promise<Readonly<Record<string, ExpoPushReceipt>>> =>
    ticketIds.length
      ? this.request(RECEIPT_URL, { ids: ticketIds }, (value) => parseExpoPushReceipts(value, ticketIds))
      : {};

  private request = async <T>(url: string, body: unknown, parse: (value: unknown) => T): Promise<T> => {
    for (let attempt = 0; attempt < HTTP_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(url, {
          body: JSON.stringify(body),
          headers: { Accept: "application/json", "Content-Type": "application/json" },
          method: "POST",
          signal: AbortSignal.timeout(10_000),
        });
        if (response.status === 429 || response.status >= 500) throw new RetryablePushError(response.status);
        if (!response.ok) throw new PermanentPushError(response.status);
        let value: unknown;
        try {
          value = await response.json();
        } catch {
          throw new RetryablePushError();
        }
        return parse(value);
      } catch (error) {
        if (error instanceof PermanentPushError) throw error;
        const retryable = error instanceof RetryablePushError ? error : new RetryablePushError();
        if (attempt === HTTP_ATTEMPTS - 1) throw retryable;
        await wait(2 ** attempt * 1_000);
      }
    }
    throw new RetryablePushError();
  };
}
