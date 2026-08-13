import { ConfigService } from "@nestjs/config";
import { createHash } from "crypto";
import { InicisIdentityAdapter } from "./inicis-identity.adapter";

const values: Record<string, string> = {
  IDENTITY_INICIS_MID: "integration-mid",
  IDENTITY_INICIS_API_KEY: "integration-api-key",
  IDENTITY_INICIS_CALLBACK_BASE_URL: "https://api.example.test",
  IDENTITY_INICIS_SEED_IV: "1234567890123456",
};

const config = {
  getOrThrow: jest.fn((key: string) => values[key]),
} as unknown as ConfigService;

describe("InicisIdentityAdapter", () => {
  const adapter = new InicisIdentityAdapter(config);

  it("maps certificate providers to the official request services", () => {
    const toss = adapter.createRequest({
      sessionId: "session-1",
      merchantTransactionId: "merchant-1",
      provider: "TOSS",
    });
    const kakao = adapter.createRequest({
      sessionId: "session-2",
      merchantTransactionId: "merchant-2",
      provider: "KAKAO",
    });

    expect(toss.action).toBe("https://sa.inicis.com/id/auth");
    expect(toss.fields.reqSvcCd).toBe("03");
    expect(kakao.action).toBe("https://sa.inicis.com/auth");
    expect(kakao.fields.reqSvcCd).toBe("01");
    expect(kakao.fields.directAgency).toBe("KAKAO");
    expect(toss.fields.authHash).toBe(
      createHash("sha256").update("integration-midmerchant-1integration-api-key").digest("hex"),
    );
  });

  it("rejects callback result URLs outside KG Inicis before requesting them", async () => {
    const fetchSpy = jest.spyOn(global, "fetch");
    await expect(
      adapter.verify(
        {
          sessionId: "session-1",
          merchantTransactionId: "merchant-1",
          provider: "NAVER",
        },
        {
          resultCode: "0000",
          authRequestUrl: "https://evil.example.test/result",
          transactionId: "transaction-1",
          token: "token",
        },
      ),
    ).rejects.toThrow("본인인증 결과 URL이 유효하지 않습니다.");
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
