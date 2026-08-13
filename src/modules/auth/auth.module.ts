import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { JwtRefreshTokenGuard } from "src/guards/refreshToken.guard";
import { KakaoGuard } from "src/guards/kakao.guard";
import { KakaoStrategy } from "src/strategys/kakao.strategy";
import { JwtRefreshTokenStrategy } from "src/strategys/refreshToken.strategy";
import { JwtAccessTokenStrategy } from "src/strategys/accessToken.strategy";
import { EmailModule } from "src/modules/email/email.module";
import { AuthRepository } from "./auth.repository";
import { AuthResolver } from "./auth.resolver";
import { AuthService } from "./auth.service";

@Module({
  imports: [JwtModule.register({ global: true }), EmailModule],
  providers: [
    AuthResolver,
    AuthService,
    AuthRepository,
    JwtRefreshTokenGuard,
    JwtRefreshTokenStrategy,
    JwtAccessTokenStrategy,
    KakaoGuard,
    KakaoStrategy,
  ],
  exports: [AuthService, KakaoGuard],
})
export class AuthModule {}
