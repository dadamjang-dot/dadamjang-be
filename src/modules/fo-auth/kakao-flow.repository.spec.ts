import { KakaoFlowRepository } from "./kakao-flow.repository";

const user = {
  userId: "10000000-0000-4000-8000-000000000001",
  userid: "user",
  email: "user@example.test",
  password: "hash",
  role: "USER",
  createdAt: new Date(),
  updatedAt: new Date(),
};

describe("KakaoFlowRepository", () => {
  it("keeps existing-user flow consumption in the token-session transaction", async () => {
    const flow = {
      flowId: "20000000-0000-4000-8000-000000000001",
      providerUserId: "kakao-user",
      status: "EXISTING_USER",
      userId: user.userId,
    };
    const returning = jest.fn().mockResolvedValue([flow]);
    const where = jest.fn().mockReturnValue({ returning });
    const set = jest.fn().mockReturnValue({ where });
    const tx = {
      execute: jest.fn().mockResolvedValue(undefined),
      update: jest.fn().mockReturnValue({ set }),
      query: { users: { findFirst: jest.fn().mockResolvedValue(user) } },
    };
    const transaction = jest.fn(async (callback: (value: typeof tx) => unknown) => callback(tx));
    const issueTokens = jest.fn().mockRejectedValue(new Error("session write failed"));
    const repository = new KakaoFlowRepository({ transaction } as never);

    await expect(
      repository.completeLoginFlow(flow.flowId, "device-hash", "callback-token", "signup-token", issueTokens),
    ).rejects.toThrow("session write failed");
    expect(issueTokens).toHaveBeenCalledWith(user, tx);
  });
});
