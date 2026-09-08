import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import type { AppConfiguration } from '../../config/app.config';
import { AccessTokenGuard } from './access-token.guard';
import { AccessTokenVerifierService } from './access-token-verifier.service';
import { AuthIntentGuard } from './auth-intent.guard';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => ({
        secret: configService.getOrThrow<AppConfiguration>('app').auth.jwtSecret,
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [AuthService, AccessTokenGuard, AccessTokenVerifierService, AuthIntentGuard],
  exports: [AccessTokenGuard, AccessTokenVerifierService],
})
export class AuthModule {}
