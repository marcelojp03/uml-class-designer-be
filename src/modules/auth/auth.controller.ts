import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { Request, Response } from 'express';
import type { AppConfiguration } from '../../config/app.config';
import {
  ACCESS_TOKEN_SECURITY_NAME,
  AUTH_INTENT_HEADER,
  AUTH_INTENT_VALUE,
  REFRESH_COOKIE_SECURITY_NAME,
} from './auth.constants';
import { CurrentUser, Public } from './auth.decorators';
import { AuthIntentGuard } from './auth-intent.guard';
import { AuthService } from './auth.service';
import type { AuthenticatedPrincipal, AuthResult } from './auth.types';
import { LoginDto, RegisterDto } from './dto/auth.dto';
import { AuthResponseDto, UserResponseDto } from './dto/auth-response.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly configService: ConfigService,
  ) {}

  @Public()
  @UseGuards(AuthIntentGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @Post('register')
  @ApiHeader({ name: AUTH_INTENT_HEADER, required: true, example: AUTH_INTENT_VALUE })
  @ApiOperation({ summary: 'Crea un usuario y una sesión segura' })
  @ApiCreatedResponse({ type: AuthResponseDto })
  @ApiConflictResponse({ description: 'No fue posible crear la cuenta con esos datos.' })
  async register(
    @Body() input: RegisterDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    return this.respondWithSession(await this.authService.register(input), response);
  }

  @Public()
  @UseGuards(AuthIntentGuard)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  @HttpCode(HttpStatus.OK)
  @Post('login')
  @ApiHeader({ name: AUTH_INTENT_HEADER, required: true, example: AUTH_INTENT_VALUE })
  @ApiOperation({ summary: 'Inicia una sesión con correo y contraseña' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiUnauthorizedResponse({ description: 'Credenciales inválidas.' })
  async login(
    @Body() input: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    return this.respondWithSession(await this.authService.login(input), response);
  }

  @Public()
  @UseGuards(AuthIntentGuard)
  @ApiCookieAuth(REFRESH_COOKIE_SECURITY_NAME)
  @ApiHeader({ name: AUTH_INTENT_HEADER, required: true, example: AUTH_INTENT_VALUE })
  @HttpCode(HttpStatus.OK)
  @Post('refresh')
  @ApiOperation({ summary: 'Rota el refresh token y emite un nuevo access token' })
  @ApiOkResponse({ type: AuthResponseDto })
  @ApiForbiddenResponse({
    description: 'Falta la intención explícita o el origen no está permitido.',
  })
  @ApiUnauthorizedResponse({ description: 'Sesión revocada, expirada o inválida.' })
  async refresh(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<AuthResponseDto> {
    return this.respondWithSession(
      await this.authService.refresh(this.readRefreshCookie(request)),
      response,
    );
  }

  @Public()
  @UseGuards(AuthIntentGuard)
  @ApiCookieAuth(REFRESH_COOKIE_SECURITY_NAME)
  @ApiHeader({ name: AUTH_INTENT_HEADER, required: true, example: AUTH_INTENT_VALUE })
  @HttpCode(HttpStatus.NO_CONTENT)
  @Post('logout')
  @ApiOperation({ summary: 'Revoca la sesión asociada a la cookie de refresh' })
  @ApiNoContentResponse()
  async logout(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    await this.authService.logout(this.readRefreshCookie(request));
    response.clearCookie(this.authConfig().refreshCookieName, this.cookieOptions());
  }

  @ApiBearerAuth(ACCESS_TOKEN_SECURITY_NAME)
  @Get('me')
  @ApiOperation({ summary: 'Devuelve el usuario de la sesión autenticada' })
  @ApiOkResponse({ type: UserResponseDto })
  @ApiUnauthorizedResponse({ description: 'Access token o sesión inválidos.' })
  me(@CurrentUser() user: AuthenticatedPrincipal): UserResponseDto {
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  private respondWithSession(result: AuthResult, response: Response): AuthResponseDto {
    response.cookie(this.authConfig().refreshCookieName, result.refreshToken, {
      ...this.cookieOptions(),
      expires: result.refreshExpiresAt,
    });
    return {
      accessToken: result.accessToken,
      tokenType: 'Bearer',
      expiresIn: result.expiresIn,
      user: result.user,
    };
  }

  private readRefreshCookie(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, unknown> | undefined;
    const value = cookies?.[this.authConfig().refreshCookieName];
    return typeof value === 'string' ? value : undefined;
  }

  private cookieOptions() {
    const auth = this.authConfig();
    return {
      httpOnly: true,
      secure: auth.refreshCookieSecure,
      sameSite: auth.refreshCookieSameSite,
      path: '/auth',
    } as const;
  }

  private authConfig(): AppConfiguration['auth'] {
    return this.configService.getOrThrow<AppConfiguration>('app').auth;
  }
}
