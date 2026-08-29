import { Inject, Injectable } from "@nestjs/common";
import { and, eq, gt, lt, sql } from "drizzle-orm";
import { Database, DRIZZLE } from "src/modules/database/database.module";
import { refreshTokens, users, type RefreshToken, type User } from "src/modules/database/schema";

export type RefreshTokenStore = Pick<Database, "insert" | "query" | "update">;

const MIN_SIGNIN_REISSUE_INTERVAL_MS = 1000;
const REFRESH_ROTATION_GRACE_SECONDS = 10;

export type RefreshRotationResult = "rotated" | "concurrent" | "invalid";

type SaveRefreshTokenInput = {
  userId: string;
  deviceId: string;
  previousRefreshToken?: string;
  signinStartedAt?: Date;
  refreshToken: string;
  refreshTokenExp: Date;
};

@Injectable()
export class AuthRepository {
  constructor(@Inject(DRIZZLE) private readonly db: Database) {}
  signinStartedAt = async () => {
    const result = await this.db.execute<{ startedAt: Date | string }>(sql`SELECT clock_timestamp() AS "startedAt"`);
    const value = result.rows[0]?.startedAt;
    const startedAt = value instanceof Date ? value : new Date(value ?? "");
    if (Number.isNaN(startedAt.getTime())) throw new Error("Failed to start sign-in");
    return startedAt;
  };
  withSigninLock = <T>(userId: string, deviceId: string, action: (store: RefreshTokenStore) => Promise<T>) =>
    this.db.transaction(async (tx) => {
      const lock = await tx.execute<{ acquired: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(hashtextextended(${`${userId}:${deviceId}`}, 2)) AS "acquired"`,
      );
      if (!lock.rows[0]?.acquired) return { acquired: false } as const;
      return { acquired: true, value: await action(tx) } as const;
    });
  findByUserid = (userid: string): Promise<User | undefined> =>
    this.db.query.users.findFirst({ where: eq(users.userid, userid) });
  findUser = (userId: string): Promise<User | undefined> =>
    this.db.query.users.findFirst({ where: eq(users.userId, userId) });
  findRefreshToken = (
    userId: string,
    deviceId: string,
    store: RefreshTokenStore = this.db,
  ): Promise<RefreshToken | undefined> =>
    store.query.refreshTokens.findFirst({
      where: and(eq(refreshTokens.userId, userId), eq(refreshTokens.deviceId, deviceId)),
    });
  saveRefreshToken = async (input: SaveRefreshTokenInput, store: RefreshTokenStore = this.db) => {
    const { previousRefreshToken, signinStartedAt, ...session } = input;
    if (previousRefreshToken === undefined) {
      const [created] = await store
        .insert(refreshTokens)
        .values(session)
        .onConflictDoNothing({ target: [refreshTokens.userId, refreshTokens.deviceId] })
        .returning({ id: refreshTokens.id });
      return Boolean(created);
    }
    const [updated] = await store
      .update(refreshTokens)
      .set({
        refreshToken: input.refreshToken,
        refreshTokenExp: input.refreshTokenExp,
        lastRotationExpiresAt: null,
        lastRotationKey: null,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(
          eq(refreshTokens.userId, input.userId),
          eq(refreshTokens.deviceId, input.deviceId),
          eq(refreshTokens.refreshToken, previousRefreshToken),
          ...(signinStartedAt === undefined
            ? []
            : [lt(refreshTokens.updatedAt, new Date(signinStartedAt.getTime() - MIN_SIGNIN_REISSUE_INTERVAL_MS))]),
        ),
      )
      .returning({ id: refreshTokens.id });
    return Boolean(updated);
  };
  rotateRefreshToken = async (input: {
    userId: string;
    deviceId: string;
    previousRefreshToken: string;
    lastRotationKey: string;
    refreshToken: string;
    refreshTokenExp: Date;
  }): Promise<RefreshRotationResult> =>
    this.db.transaction(async (tx) => {
      const [rotated] = await tx
        .update(refreshTokens)
        .set({
          refreshToken: input.refreshToken,
          refreshTokenExp: input.refreshTokenExp,
          lastRotationKey: input.lastRotationKey,
          lastRotationExpiresAt: sql`clock_timestamp() + make_interval(secs => ${REFRESH_ROTATION_GRACE_SECONDS})`,
          updatedAt: sql`clock_timestamp()`,
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
      if (rotated) return "rotated";
      return (await this.hasRecentRotation(input.userId, input.deviceId, input.lastRotationKey, tx))
        ? "concurrent"
        : "invalid";
    });
  hasRecentRotation = async (
    userId: string,
    deviceId: string,
    lastRotationKey: string,
    store: RefreshTokenStore = this.db,
  ) =>
    Boolean(
      await store.query.refreshTokens.findFirst({
        columns: { id: true },
        where: and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.deviceId, deviceId),
          eq(refreshTokens.lastRotationKey, lastRotationKey),
          sql`${refreshTokens.lastRotationExpiresAt} > clock_timestamp()`,
        ),
      }),
    );
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
