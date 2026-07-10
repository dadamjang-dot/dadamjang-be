import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, isNull } from "drizzle-orm";
import { hashToken } from "src/common/security/token-hash";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { authIdentities, kakaoSignupTokens, refreshTokens, users, type RefreshToken, type User } from "src/modules/database/schema";

@Injectable()
export class AuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  findByUserid = (userid: string): Promise<User | undefined> => this.db.query.users.findFirst({ where: eq(users.userid, userid) });
  findUser = (userId: string): Promise<User | undefined> => this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  findRefreshToken = (userId: string, deviceId: string): Promise<RefreshToken | undefined> => this.db.query.refreshTokens.findFirst({ where: and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId)) });
  saveRefreshToken = async (input: { userId: string; deviceId: string; refreshToken: string; refreshTokenExp: Date }) => { await this.db.insert(refreshTokens).values(input).onConflictDoUpdate({ target: [refreshTokens.userId, refreshTokens.deviceId], set: { refreshToken: input.refreshToken, refreshTokenExp: input.refreshTokenExp, updatedAt: new Date() } }); };
  deleteRefreshToken = async (userId: string, deviceId: string) => { await this.db.delete(refreshTokens).where(and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId))); };
  findKakaoUser = async (providerUserId: string) => { const identity = await this.db.query.authIdentities.findFirst({ where: and(eq(authIdentities.provider, "kakao"), eq(authIdentities.providerUserId, providerUserId)) }); return identity ? this.findUser(identity.userId) : undefined; };
  createKakaoSignupToken = async (token: string, providerUserId: string, email: string) => { await this.db.insert(kakaoSignupTokens).values({ tokenHash: hashToken(token), providerUserId, email, expiresAt: new Date(Date.now() + 15 * 60 * 1000) }); };
  consumeKakaoSignupTokenAndCreateUser = async (token: string, input: { userId: string; userid: string; password: string }) => this.db.transaction(async (tx) => { const [signupToken] = await tx.update(kakaoSignupTokens).set({ usedAt: new Date() }).where(and(eq(kakaoSignupTokens.tokenHash, hashToken(token)), isNull(kakaoSignupTokens.usedAt), gt(kakaoSignupTokens.expiresAt, new Date()))).returning(); if (!signupToken?.email) return undefined; const [user] = await tx.insert(users).values({ ...input, email: signupToken.email }).returning(); await tx.insert(authIdentities).values({ userId: user.userId, provider: "kakao", providerUserId: signupToken.providerUserId }); return user; });
}
