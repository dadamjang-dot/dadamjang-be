import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { JwtRefreshTokenGuard } from "src/guards/refreshToken.guard";
import { KakaoGuard } from "src/guards/kakao.guard";
import { KakaoStrategy } from "src/strategys/kakao.strategy";
import { JwtRefreshTokenStrategy } from "src/strategys/refreshToken.strategy";
import { EmailModule } from "src/modules/email/email.module";
import { AuthController } from "./auth.controller";
import { AuthRepository } from "./auth.repository";
import { AuthResolver } from "./auth.resolver";
import { AuthService } from "./auth.service";

@Module({
  imports: [JwtModule.register({ global: true }), EmailModule],
  controllers: [AuthController],
  providers: [
    AuthResolver,
    AuthService,
    AuthRepository,
    JwtRefreshTokenGuard,
    JwtRefreshTokenStrategy,
    KakaoGuard,
    KakaoStrategy,
  ],
  exports: [AuthService],
})
export class AuthModule {}
