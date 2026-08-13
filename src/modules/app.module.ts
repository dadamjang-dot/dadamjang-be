import { HttpException, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import { GraphQLError } from "graphql";
import { AuthModule } from "./auth/auth.module";
import { DatabaseModule } from "./database/database.module";
import { EmailModule } from "./email/email.module";
import { MediaModule } from "./media/media.module";
import { AdminModule } from "./admin/admin.module";
import { CartModule } from "./cart/cart.module";
import { CatalogModule } from "./catalog/catalog.module";
import { ComparisonModule } from "./comparison/comparison.module";
import { EventModule } from "./event/event.module";
import { FeedModule } from "./feed/feed.module";
import { OrderModule } from "./order/order.module";
import { PartnerModule } from "./partner/partner.module";
import { WishModule } from "./wish/wish.module";
import { StylePostsModule } from "./style-posts/style-posts.module";
import { WishLibraryModule } from "./wish-library/wish-library.module";

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      context: ({ req, res }) => ({ req, res }),
      formatError: (formattedError, error) => {
        const originalError = error instanceof GraphQLError ? error.originalError : undefined;
        const extensions = Object.fromEntries(
          Object.entries(formattedError.extensions ?? {}).filter(([key]) => key !== "stacktrace"),
        );
        if (originalError instanceof HttpException) return { ...formattedError, extensions };
        return { message: "Internal server error", extensions: { code: "INTERNAL_SERVER_ERROR" } };
      },
    }),
    DatabaseModule,
    AuthModule,
    EmailModule,
    MediaModule,
    AdminModule,
    CartModule,
    CatalogModule,
    ComparisonModule,
    EventModule,
    FeedModule,
    OrderModule,
    PartnerModule,
    WishModule,
    WishLibraryModule,
    StylePostsModule,
  ],
})
export class AppModule {}
