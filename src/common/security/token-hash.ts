import { createHash } from "crypto";

/**
 * 토큰 원문을 SHA-256 hex digest로 변환한다.
 *
 * @param token 해시할 토큰 원문
 * @returns SHA-256 hex digest
 */
export const hashToken = (token: string) => {
  return createHash("sha256").update(token).digest("hex");
};
