import { HttpException, HttpStatus, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, ApolloDriverConfig } from "@nestjs/apollo";
import type { ExpressContextFunctionArgument } from "@as-integrations/express5";
import { GraphQLError } from "graphql";
import { requestBudgetRule } from "src/common/graphql/request-budget";
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
import { IdentityVerificationModule } from "./identity-verification/identity-verification.module";
import { FoAuthModule } from "./fo-auth/fo-auth.module";
import { KakaoFlowModule } from "./fo-auth/kakao-flow.module";

const graphQlErrorCode = (status: number) => {
  if (status === HttpStatus.BAD_REQUEST) return "BAD_USER_INPUT";
  if (status === HttpStatus.UNAUTHORIZED) return "UNAUTHENTICATED";
  if (status === HttpStatus.FORBIDDEN) return "FORBIDDEN";
  if (status === HttpStatus.NOT_FOUND) return "NOT_FOUND";
  if (status === HttpStatus.CONFLICT) return "CONFLICT";
  if (status === HttpStatus.TOO_MANY_REQUESTS) return "TOO_MANY_REQUESTS";
  if (status === HttpStatus.SERVICE_UNAVAILABLE) return "SERVICE_UNAVAILABLE";
  return "INTERNAL_SERVER_ERROR";
};

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ".env",
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      autoSchemaFile: true,
      validationRules: [requestBudgetRule],
      context: ({ req, res }: ExpressContextFunctionArgument) => ({ req, res }),
      formatError: (formattedError, error) => {
        const originalError = error instanceof GraphQLError ? error.originalError : undefined;
        const extensions = Object.fromEntries(
          Object.entries(formattedError.extensions ?? {}).filter(([key]) => key !== "stacktrace"),
        );
        if (extensions.code === "GRAPHQL_PARSE_FAILED" || extensions.code === "GRAPHQL_VALIDATION_FAILED")
          return { ...formattedError, extensions };
        if (originalError instanceof HttpException)
          return {
            ...formattedError,
            extensions: { ...extensions, code: graphQlErrorCode(originalError.getStatus()) },
          };
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
    IdentityVerificationModule,
    FoAuthModule,
    KakaoFlowModule,
  ],
})
export class AppModule {}
