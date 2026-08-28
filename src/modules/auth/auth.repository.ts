import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { refreshTokens, users, type RefreshToken, type User } from "src/modules/database/schema";

@Injectable()
export class AuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  findByUserid = (userid: string): Promise<User | undefined> =>
    this.db.query.users.findFirst({ where: eq(users.userid, userid) });
  findUser = (userId: string): Promise<User | undefined> =>
    this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  findRefreshToken = (userId: string, deviceId: string): Promise<RefreshToken | undefined> =>
    this.db.query.refreshTokens.findFirst({
      where: and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId)),
    });
  saveRefreshToken = async (input: {
    userId: string;
    deviceId: string;
    refreshToken: string;
    refreshTokenExp: Date;
  }) => {
    await this.db
      .insert(refreshTokens)
      .values(input)
      .onConflictDoUpdate({
        target: [refreshTokens.userId, refreshTokens.deviceId],
        set: {
          refreshToken: input.refreshToken,
          refreshTokenExp: input.refreshTokenExp,
          updatedAt: new Date(),
        },
      });
  };
  rotateRefreshToken = async (input: {
    userId: string;
    deviceId: string;
    previousRefreshToken: string;
    refreshToken: string;
    refreshTokenExp: Date;
  }) => {
    const [rotated] = await this.db
      .update(refreshTokens)
      .set({
        refreshToken: input.refreshToken,
        refreshTokenExp: input.refreshTokenExp,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(refreshTokens.userId, input.userId),
          eq(refreshTokens.deviceId, input.deviceId),
          eq(refreshTokens.refreshToken, input.previousRefreshToken),
          gt(refreshTokens.refreshTokenExp, new Date()),
        ),
      )
      .returning({ id: refreshTokens.id });
    return Boolean(rotated);
  };
  deleteRefreshToken = async (userId: string, deviceId: string, refreshToken: string) => {
    const [deleted] = await this.db
      .delete(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.deviceId, deviceId),
          eq(refreshTokens.refreshToken, refreshToken),
        ),
      )
      .returning({ id: refreshTokens.id });
    return Boolean(deleted);
  };
}
