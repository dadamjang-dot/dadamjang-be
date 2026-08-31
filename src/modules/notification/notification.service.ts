import { Inject, Injectable } from "@nestjs/common";
import {
  CustomBadRequestException,
  CustomNotFoundException,
  CustomUnauthorizedException,
} from "src/common/errors/custom-exceptions";
import { Database, DatabaseTransaction, DRIZZLE } from "src/modules/database/database.module";
import type { OrderStatus } from "src/modules/order/order.constant";
import { NotificationRepository } from "./notification.repository";
import {
  FoNotification,
  FoNotificationConnection,
  FoNotificationPreferences,
  FoNotificationType,
  RegisterFoPushDeviceInput,
  UpdateFoNotificationPreferencesInput,
} from "./notification.types";

const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const ORDER_NOTIFICATION_COPY = {
  PAID: { title: "결제가 완료됐어요", body: "주문 상품을 준비할게요." },
  FULFILLING: { title: "상품을 준비하고 있어요", body: "준비가 끝나면 다시 알려드릴게요." },
  COMPLETED: { title: "주문이 완료됐어요", body: "구매한 상품을 확인해 보세요." },
  FAILED: { title: "주문 처리가 완료되지 않았어요", body: "주문 상세에서 상태를 확인해 주세요." },
  CANCELLED: { title: "주문이 취소됐어요", body: "주문 상세에서 취소 내용을 확인해 주세요." },
} as const satisfies Record<Exclude<OrderStatus, "PAYMENT_PENDING">, { title: string; body: string }>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const pageSize = (first?: number) => Math.min(Math.max(first ?? DEFAULT_PAGE_SIZE, 1), MAX_PAGE_SIZE);

const encodeCursor = (notification: FoNotification) =>
  Buffer.from(
    JSON.stringify({
      createdAt: notification.createdAt.toISOString(),
      notificationId: notification.notificationId,
    }),
  ).toString("base64url");

const decodeCursor = (value: string) => {
  try {
    const cursor: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (!isRecord(cursor) || typeof cursor.createdAt !== "string" || typeof cursor.notificationId !== "string")
      throw new Error();
    const createdAt = new Date(cursor.createdAt);
    if (!UUID_PATTERN.test(cursor.notificationId) || Number.isNaN(createdAt.getTime())) throw new Error();
    return { createdAt, notificationId: cursor.notificationId };
  } catch {
    throw new CustomBadRequestException("알림 커서가 올바르지 않습니다.");
  }
};

const toNotification = (notification: Omit<FoNotification, "type"> & { type: string }): FoNotification => ({
  ...notification,
  type: notification.type as FoNotificationType,
});

@Injectable()
export class NotificationService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly repository: NotificationRepository,
  ) {}

  list = async (userId: string, first?: number, after?: string): Promise<FoNotificationConnection> => {
    const limit = pageSize(first);
    const { rows, unreadCount } = await this.repository.list(userId, limit, after ? decodeCursor(after) : undefined);
    const nodes = rows.slice(0, limit).map(toNotification);
    const hasNextPage = rows.length > limit;
    return {
      nodes,
      nextCursor: hasNextPage && nodes.length ? encodeCursor(nodes[nodes.length - 1] as FoNotification) : null,
      hasNextPage,
      unreadCount,
    };
  };

  get = async (userId: string, notificationId: string): Promise<FoNotification> => {
    const notification = await this.repository.get(userId, notificationId);
    if (!notification) throw new CustomNotFoundException("알림을 찾을 수 없습니다.");
    return toNotification(notification);
  };

  markRead = async (userId: string, notificationId: string): Promise<FoNotification> => {
    const notification = await this.repository.markRead(userId, notificationId);
    if (!notification) throw new CustomNotFoundException("알림을 찾을 수 없습니다.");
    return toNotification(notification);
  };

  markAllRead = (userId: string): Promise<boolean> => this.repository.markAllRead(userId);

  getPreferences = (userId: string): Promise<FoNotificationPreferences> => this.repository.getPreferences(userId);

  updatePreferences = (
    userId: string,
    input: UpdateFoNotificationPreferencesInput,
  ): Promise<FoNotificationPreferences> => {
    if (Object.values(input).some((value) => value === null))
      throw new CustomBadRequestException("알림 설정이 올바르지 않습니다.");
    return this.repository.updatePreferences(userId, input);
  };

  createOrderStatus = async (
    tx: DatabaseTransaction,
    input: { userId: string; orderId: string; status: OrderStatus },
  ): Promise<void> => {
    if (input.status === "PAYMENT_PENDING") return;
    const copy = ORDER_NOTIFICATION_COPY[input.status];
    await this.repository.create(tx, {
      userId: input.userId,
      preferenceCategory: "orderPushEnabled",
      notification: {
        userId: input.userId,
        type: FoNotificationType.ORDER_STATUS,
        title: copy.title,
        body: copy.body,
        route: `/order/${input.orderId}`,
        entityId: input.orderId,
        dedupeKey: `order:${input.orderId}:${input.status}`,
      },
    });
  };

  createWishPriceDrop = async (
    tx: DatabaseTransaction,
    input: { userIds: readonly string[]; productId: string; skuUpdatedAt: Date; newPrice: number },
  ): Promise<void> => {
    for (const userId of new Set(input.userIds))
      await this.repository.create(tx, {
        userId,
        preferenceCategory: "wishPushEnabled",
        notification: {
          userId,
          type: FoNotificationType.WISH_PRICE_DROP,
          title: "위시 상품 가격이 내려갔어요",
          body: "찜한 상품을 지금 확인해 보세요.",
          route: `/product/${input.productId}`,
          entityId: input.productId,
          dedupeKey: `wish-price:${input.productId}:${input.skuUpdatedAt.toISOString()}:${input.newPrice}`,
        },
      });
  };

  createWishRestock = async (
    tx: DatabaseTransaction,
    input: { userIds: readonly string[]; productId: string; skuUpdatedAt: Date },
  ): Promise<void> => {
    for (const userId of new Set(input.userIds))
      await this.repository.create(tx, {
        userId,
        preferenceCategory: "wishPushEnabled",
        notification: {
          userId,
          type: FoNotificationType.WISH_RESTOCK,
          title: "위시 상품이 다시 입고됐어요",
          body: "품절되기 전에 확인해 보세요.",
          route: `/product/${input.productId}`,
          entityId: input.productId,
          dedupeKey: `wish-stock:${input.productId}:${input.skuUpdatedAt.toISOString()}`,
        },
      });
  };

  createStyleLike = async (
    tx: DatabaseTransaction,
    input: { authorUserId: string; actorUserId: string; stylePostId: string },
  ): Promise<void> => {
    if (input.authorUserId === input.actorUserId) return;
    await this.repository.create(tx, {
      userId: input.authorUserId,
      preferenceCategory: "stylePushEnabled",
      notification: {
        userId: input.authorUserId,
        type: FoNotificationType.STYLE_LIKE,
        title: "스타일에 좋아요가 달렸어요",
        body: "내 스타일 게시물을 확인해 보세요.",
        route: `/style/${input.stylePostId}`,
        entityId: input.stylePostId,
        dedupeKey: `style-like:${input.stylePostId}:${input.actorUserId}`,
      },
    });
  };

  registerDevice = async (
    userId: string,
    installationId: string,
    input: RegisterFoPushDeviceInput,
  ): Promise<boolean> => {
    const expoPushToken = input.expoPushToken.trim();
    if (!expoPushToken || expoPushToken.length > 255)
      throw new CustomBadRequestException("Expo Push token이 올바르지 않습니다.");
    return this.db.transaction(async (tx) => {
      if (!(await this.repository.lockActiveRefreshSession(tx, userId, installationId)))
        throw new CustomUnauthorizedException("로그인이 필요합니다.");
      return this.repository.transferDevice(tx, { ...input, expoPushToken, userId, installationId });
    });
  };

  unregisterDevice = async (userId: string, installationId: string): Promise<boolean> => {
    await this.db.transaction((tx) => this.repository.disableInstallation(tx, userId, installationId, "UNREGISTERED"));
    return true;
  };
}
