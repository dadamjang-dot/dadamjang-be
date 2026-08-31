import {
  ExpoPushSender,
  PermanentPushError,
  RetryablePushError,
  parseExpoPushTickets,
  type ExpoPushMessage,
} from "./notification.sender";

const message = (index: number): ExpoPushMessage => ({
  to: `ExponentPushToken[token-${index}]`,
  title: `Title ${index}`,
  body: `Body ${index}`,
  data: {
    notificationId: `81000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    type: "ORDER_STATUS",
    entityId: `90000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  },
});

const jsonResponse = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { headers: { "content-type": "application/json" }, status });

describe("ExpoPushSender", () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it("sends at most 100 data-only messages per Expo request", async () => {
    let ticketIndex = 0;
    const requestBodies: ExpoPushMessage[][] = [];
    jest.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as ExpoPushMessage[];
      requestBodies.push(body);
      return jsonResponse({
        data: body.map(() => ({ status: "ok", id: `ticket-${ticketIndex++}` })),
      });
    });

    const tickets = await new ExpoPushSender().send(Array.from({ length: 205 }, (_, index) => message(index)));

    expect(requestBodies.map((body) => body.length)).toEqual([100, 100, 5]);
    expect(requestBodies[0]?.[0]).toEqual(message(0));
    expect(tickets).toHaveLength(205);
  });

  it("uses the Expo endpoint, JSON headers, and a ten-second timeout", async () => {
    const timeoutSignal = new AbortController().signal;
    const timeout = jest.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutSignal);
    const request = jest
      .spyOn(global, "fetch")
      .mockResolvedValue(jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }));

    await new ExpoPushSender().send([message(1)]);

    expect(request).toHaveBeenCalledWith("https://exp.host/--/api/v2/push/send", {
      body: JSON.stringify([message(1)]),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      signal: timeoutSignal,
    });
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("retries network failures", async () => {
    jest.useFakeTimers();
    const request = jest
      .spyOn(global, "fetch")
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }));

    const delivery = new ExpoPushSender().send([message(1)]);
    await jest.advanceTimersByTimeAsync(1_000);

    await expect(delivery).resolves.toEqual([{ status: "ok", id: "ticket-1" }]);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("retries 429 and 5xx responses with exponential delays", async () => {
    jest.useFakeTimers();
    const request = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ data: [{ status: "ok", id: "ticket-1" }] }));

    const delivery = new ExpoPushSender().send([message(1)]);
    await jest.advanceTimersByTimeAsync(3_000);

    await expect(delivery).resolves.toEqual([{ status: "ok", id: "ticket-1" }]);
    expect(request).toHaveBeenCalledTimes(3);
  });

  it("does not retry permanent 4xx responses", async () => {
    const request = jest.spyOn(global, "fetch").mockResolvedValue(jsonResponse({}, 400));

    await expect(new ExpoPushSender().send([message(1)])).rejects.toEqual(new PermanentPushError(400));
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("rejects non-JSON and wrong-length ticket responses as retryable", async () => {
    jest.useFakeTimers();
    const request = jest
      .spyOn(global, "fetch")
      .mockImplementation(async () => new Response("not-json", { status: 200 }));

    const delivery = new ExpoPushSender().send([message(1)]);
    const rejected = expect(delivery).rejects.toBeInstanceOf(RetryablePushError);
    await jest.runAllTimersAsync();

    await rejected;
    expect(request).toHaveBeenCalledTimes(3);
    expect(() => parseExpoPushTickets({ data: [] }, 1)).toThrow(RetryablePushError);
  });

  it("rejects malformed ticket entries", () => {
    const malformed = [
      { data: [{ status: "ok", id: "" }] },
      { data: [{ status: "error" }] },
      { data: [{ status: "error", message: "bad", details: { error: 1 } }] },
      { data: [{ status: "unknown" }] },
    ];

    for (const value of malformed) expect(() => parseExpoPushTickets(value, 1)).toThrow(RetryablePushError);
  });

  it("validates every requested receipt before returning it", async () => {
    const request = jest.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          "ticket-1": { status: "ok" },
          "ticket-2": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
        },
      }),
    );

    const receipts = await new ExpoPushSender().getReceipts(["ticket-1", "ticket-2"]);

    expect(receipts).toEqual({
      "ticket-1": { status: "ok" },
      "ticket-2": { status: "error", message: "gone", details: { error: "DeviceNotRegistered" } },
    });
    expect(request).toHaveBeenCalledWith("https://exp.host/--/api/v2/push/getReceipts", {
      body: JSON.stringify({ ids: ["ticket-1", "ticket-2"] }),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      method: "POST",
      signal: expect.any(AbortSignal),
    });
  });

  it("accepts a valid subset of requested receipt IDs", async () => {
    const request = jest.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: {
          "ticket-1": { status: "ok" },
        },
      }),
    );

    await expect(new ExpoPushSender().getReceipts(["ticket-1", "ticket-2"])).resolves.toEqual({
      "ticket-1": { status: "ok" },
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("retries receipt maps with unexpected ticket IDs or malformed requested receipts", async () => {
    jest.useFakeTimers();
    const request = jest
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(jsonResponse({ data: { "unexpected-ticket": { status: "ok" } } }))
      .mockImplementation(async () => jsonResponse({ data: { "ticket-1": { status: "error" } } }));

    const delivery = new ExpoPushSender().getReceipts(["ticket-1"]);
    const rejected = expect(delivery).rejects.toBeInstanceOf(RetryablePushError);
    await jest.runAllTimersAsync();

    await rejected;
    expect(request).toHaveBeenCalledTimes(3);
  });
});
