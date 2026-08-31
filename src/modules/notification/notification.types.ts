import { Field, ID, InputType, Int, ObjectType, registerEnumType } from "@nestjs/graphql";

export enum FoNotificationType {
  ORDER_STATUS = "ORDER_STATUS",
  WISH_PRICE_DROP = "WISH_PRICE_DROP",
  WISH_RESTOCK = "WISH_RESTOCK",
  STYLE_LIKE = "STYLE_LIKE",
}

export enum FoPushPlatform {
  IOS = "IOS",
  ANDROID = "ANDROID",
}

registerEnumType(FoNotificationType, { name: "FoNotificationType" });
registerEnumType(FoPushPlatform, { name: "FoPushPlatform" });

@ObjectType()
export class FoNotification {
  @Field(() => ID)
  notificationId!: string;
  @Field(() => FoNotificationType)
  type!: FoNotificationType;
  @Field()
  title!: string;
  @Field()
  body!: string;
  @Field()
  route!: string;
  @Field(() => ID)
  entityId!: string;
  @Field(() => Date, { nullable: true })
  readAt!: Date | null;
  @Field(() => Date)
  createdAt!: Date;
}

@ObjectType()
export class FoNotificationConnection {
  @Field(() => [FoNotification])
  nodes!: FoNotification[];
  @Field(() => String, { nullable: true })
  nextCursor!: string | null;
  @Field()
  hasNextPage!: boolean;
  @Field(() => Int)
  unreadCount!: number;
}

@ObjectType()
export class FoNotificationPreferences {
  @Field()
  pushEnabled!: boolean;
  @Field()
  orderPushEnabled!: boolean;
  @Field()
  wishPushEnabled!: boolean;
  @Field()
  stylePushEnabled!: boolean;
  @Field(() => Date)
  updatedAt!: Date;
}

@InputType()
export class RegisterFoPushDeviceInput {
  @Field()
  expoPushToken!: string;
  @Field(() => FoPushPlatform)
  platform!: FoPushPlatform;
}

@InputType()
export class UpdateFoNotificationPreferencesInput {
  @Field({ nullable: true })
  pushEnabled?: boolean;
  @Field({ nullable: true })
  orderPushEnabled?: boolean;
  @Field({ nullable: true })
  wishPushEnabled?: boolean;
  @Field({ nullable: true })
  stylePushEnabled?: boolean;
}
