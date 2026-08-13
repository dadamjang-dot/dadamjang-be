import { Injectable } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { KISA_SEED_CBC } from "@kr-yeon/kisa-seed";
import { createHash } from "crypto";
import { CustomUnauthorizedException } from "src/common/errors/custom-exceptions";
import type { InicisCallbackInput, InicisSessionRequest, InicisVerifiedResult } from "./identity-verification.types";

const allowedResultHosts = new Set(["fcsa.inicis.com", "kssa.inicis.com"]);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

type InicisResultResponse = {
  readonly resultCode: string;
  readonly txId: string;
  readonly mTxId: string;
  readonly svcCd: string;
  readonly providerDevCd: string;
  readonly userBirthday: string;
  readonly userCi: string;
};

@Injectable()
export class InicisIdentityAdapter {
  constructor(private readonly configService: ConfigService) {}

  createRequest = (session: InicisSessionRequest) => {
    const mid = this.configService.getOrThrow<string>("IDENTITY_INICIS_MID");
    const apiKey = this.configService.getOrThrow<string>("IDENTITY_INICIS_API_KEY");
    const callbackBaseUrl = this.configService.getOrThrow<string>("IDENTITY_INICIS_CALLBACK_BASE_URL");
    const reqSvcCd = session.provider === "TOSS" ? "03" : "01";
    return {
      action: reqSvcCd === "03" ? "https://sa.inicis.com/id/auth" : "https://sa.inicis.com/auth",
      fields: {
        mid,
        reqSvcCd,
        mTxId: session.merchantTransactionId,
        successUrl: `${callbackBaseUrl}/api/auth/identity/inicis/success/${session.sessionId}`,
        failUrl: `${callbackBaseUrl}/api/auth/identity/inicis/fail/${session.sessionId}`,
        authHash: createHash("sha256").update(`${mid}${session.merchantTransactionId}${apiKey}`).digest("hex"),
        directAgency: session.provider,
        flgFixedUser: "N",
        reservedMsg: "isUseToken=Y",
      },
    } as const;
  };

  verify = async (session: InicisSessionRequest, callback: InicisCallbackInput): Promise<InicisVerifiedResult> => {
    if (callback.resultCode !== "0000" || !callback.authRequestUrl || !callback.transactionId || !callback.token) {
      throw new CustomUnauthorizedException("본인인증 결과가 유효하지 않습니다.");
    }
    const requestUrl = new URL(callback.authRequestUrl);
    if (requestUrl.protocol !== "https:" || !allowedResultHosts.has(requestUrl.hostname))
      throw new CustomUnauthorizedException("본인인증 결과 URL이 유효하지 않습니다.");
    const response = await fetch(requestUrl, {
      method: "POST",
      headers: { "content-type": "application/json;charset=utf-8" },
      body: JSON.stringify({
        mid: this.configService.getOrThrow<string>("IDENTITY_INICIS_MID"),
        txId: callback.transactionId,
      }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) throw new CustomUnauthorizedException("본인인증 결과 조회에 실패했습니다.");
    const result = this.parseResult(await response.json());
    if (
      result.resultCode !== "0000" ||
      result.txId !== callback.transactionId ||
      result.mTxId !== session.merchantTransactionId ||
      result.providerDevCd !== session.provider
    ) {
      throw new CustomUnauthorizedException("본인인증 결과가 일치하지 않습니다.");
    }
    return {
      ci: this.decrypt(result.userCi, callback.token),
      birthday: this.decrypt(result.userBirthday, callback.token),
      certificateProvider: result.providerDevCd,
    };
  };

  private decrypt = (value: string, token: string) => {
    const iv = this.configService.getOrThrow<string>("IDENTITY_INICIS_SEED_IV");
    const ivBase64 = Buffer.byteLength(iv, "utf8") === 16 ? Buffer.from(iv, "utf8").toString("base64") : iv;
    return KISA_SEED_CBC.decrypt(token, ivBase64, value).replace(/\0+$/u, "").trim();
  };

  private parseResult = (value: unknown): InicisResultResponse => {
    if (!isRecord(value)) throw new CustomUnauthorizedException("본인인증 결과 형식이 유효하지 않습니다.");
    const required = ["resultCode", "txId", "mTxId", "svcCd", "providerDevCd", "userBirthday", "userCi"] as const;
    if (required.some((field) => typeof value[field] !== "string"))
      throw new CustomUnauthorizedException("본인인증 결과 형식이 유효하지 않습니다.");
    return {
      resultCode: String(value.resultCode),
      txId: String(value.txId),
      mTxId: String(value.mTxId),
      svcCd: String(value.svcCd),
      providerDevCd: String(value.providerDevCd),
      userBirthday: String(value.userBirthday),
      userCi: String(value.userCi),
    };
  };
}
