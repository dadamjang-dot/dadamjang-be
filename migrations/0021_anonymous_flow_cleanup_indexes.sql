CREATE INDEX "kakao_login_flows_cleanup_expires_idx"
  ON "kakaoLoginFlows" ("expiresAt", "flowId");
CREATE INDEX "kakao_login_flows_cleanup_consumed_idx"
  ON "kakaoLoginFlows" ("consumedAt", "flowId")
  WHERE "consumedAt" IS NOT NULL;

CREATE INDEX "identity_verification_cleanup_expires_idx"
  ON "identityVerificationSessions" ("expiresAt", "sessionId");
CREATE INDEX "identity_verification_cleanup_consumed_idx"
  ON "identityVerificationSessions" ("consumedAt", "sessionId")
  WHERE "consumedAt" IS NOT NULL;
