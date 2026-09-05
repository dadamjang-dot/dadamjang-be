import { Inject, Injectable } from "@nestjs/common";
import { createHash, timingSafeEqual } from "crypto";
import { isIP } from "node:net";
import { sql } from "drizzle-orm";
import type { Request } from "express";
import { CustomBadRequestException, CustomTooManyRequestsException } from "src/common/errors/custom-exceptions";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { requestAdmissions } from "src/modules/database/schema";

export type RequestOrigin = Readonly<{ ip: string; deviceId?: string }>;

export type AdmissionRule = Readonly<{
  scopeType: string;
  value: string;
  limit: number;
  windowMs: number;
}>;

class AdmissionRejected extends Error {
  constructor(readonly scopeType: string) {
    super(scopeType);
  }
}

export const requestOriginFromRequest = (req: Pick<Request, "headers" | "ip">): RequestOrigin => {
  const value = req.headers["x-device-id"];
  const deviceId = (Array.isArray(value) ? value[0] : value)?.trim();
  let ip = req.ip?.trim() || "unknown";
  const secret = process.env.DADAMJANG_BFF_SECRET;
  const presented = req.headers["x-dadamjang-bff-secret"];
  const forwardedIp = req.headers["x-dadamjang-client-ip"];
  if (presented !== undefined || forwardedIp !== undefined) {
    if (
      !secret ||
      secret.length < 32 ||
      typeof presented !== "string" ||
      !timingSafeEqual(createHash("sha256").update(secret).digest(), createHash("sha256").update(presented).digest())
    )
      throw new CustomBadRequestException("Untrusted BFF request origin");
    if (typeof forwardedIp !== "string" || !isIP(forwardedIp))
      throw new CustomBadRequestException("Invalid BFF client IP");
    ip = forwardedIp;
  }
  return deviceId ? { ip, deviceId } : { ip };
};

@Injectable()
export class AdmissionLimiter {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}

  consume = async (action: string, rules: readonly AdmissionRule[], now = new Date()) =>
    (await this.consumeDecision(action, rules, now)).allowed;

  assertAllowed = async (
    action: string,
    rules: readonly AdmissionRule[],
    message: string | ((deniedScopeType: string) => string),
  ) => {
    const decision = await this.consumeDecision(action, rules, new Date());
    if (decision.allowed) return;
    throw new CustomTooManyRequestsException(
      typeof message === "function" ? message(decision.deniedScopeType) : message,
    );
  };

  private consumeDecision = async (action: string, rules: readonly AdmissionRule[], now: Date) => {
    const admissions = rules
      .map((rule) => ({
        ...rule,
        scopeHash: createHash("sha256").update(rule.value).digest("hex"),
      }))
      .sort((left, right) => {
        const leftLock = `${left.scopeType}:${left.scopeHash}`;
        const rightLock = `${right.scopeType}:${right.scopeHash}`;
        return leftLock < rightLock ? -1 : leftLock > rightLock ? 1 : 0;
      });
    try {
      await this.db.transaction(async (tx) => {
        await tx.execute(sql`
          DELETE FROM "requestAdmission"
          WHERE ctid IN (
            SELECT ctid
            FROM "requestAdmission"
            WHERE "expiresAt" <= ${now}
            ORDER BY "expiresAt"
            LIMIT 100
          )
        `);
        for (const admission of admissions) {
          const expiresAt = new Date(now.getTime() + admission.windowMs);
          const [accepted] = await tx
            .insert(requestAdmissions)
            .values({
              action,
              scopeType: admission.scopeType,
              scopeHash: admission.scopeHash,
              windowStartedAt: now,
              expiresAt,
              updatedAt: now,
            })
            .onConflictDoUpdate({
              target: [requestAdmissions.action, requestAdmissions.scopeType, requestAdmissions.scopeHash],
              set: {
                requestCount: sql`CASE WHEN ${requestAdmissions.expiresAt} <= ${now} THEN 1 ELSE ${requestAdmissions.requestCount} + 1 END`,
                windowStartedAt: sql`CASE WHEN ${requestAdmissions.expiresAt} <= ${now} THEN ${now} ELSE ${requestAdmissions.windowStartedAt} END`,
                expiresAt: sql`CASE WHEN ${requestAdmissions.expiresAt} <= ${now} THEN ${expiresAt} ELSE ${requestAdmissions.expiresAt} END`,
                updatedAt: now,
              },
              setWhere: sql`${requestAdmissions.expiresAt} <= ${now} OR ${requestAdmissions.requestCount} < ${admission.limit}`,
            })
            .returning({ requestCount: requestAdmissions.requestCount });
          if (!accepted) throw new AdmissionRejected(admission.scopeType);
        }
      });
      return { allowed: true } as const;
    } catch (error) {
      if (error instanceof AdmissionRejected) return { allowed: false, deniedScopeType: error.scopeType } as const;
      throw error;
    }
  };
}
