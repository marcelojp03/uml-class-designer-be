import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import type { AppConfiguration } from '../../config/app.config';
import { PrismaService } from '../database/prisma.service';
import { IS_PUBLIC_KEY } from './auth.constants';
import type { AccessTokenClaims, AuthenticatedPrincipal } from './auth.types';

type AuthenticatedRequest = Request & { user?: AuthenticatedPrincipal };

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.extractBearerToken(request);
    const config = this.configService.getOrThrow<AppConfiguration>('app');

    let payload: AccessTokenClaims;
    try {
      payload = await this.jwtService.verifyAsync<AccessTokenClaims>(token, {
        secret: config.auth.jwtSecret,
        algorithms: ['HS256'],
        issuer: config.auth.jwtIssuer,
        audience: config.auth.jwtAudience,
      });
    } catch {
      throw new UnauthorizedException('Authentication is required.');
    }

    if (payload.typ !== 'access' || !isUUID(payload.sub, '4') || !isUUID(payload.sid, '4')) {
      throw new UnauthorizedException('Authentication is required.');
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: payload.sid,
        userId: payload.sub,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: {
        id: true,
        user: { select: { id: true, email: true, displayName: true } },
      },
    });
    if (!session) {
      throw new UnauthorizedException('Authentication is required.');
    }

    request.user = { ...session.user, sessionId: session.id };
    return true;
  }

  private extractBearerToken(request: Request): string {
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Authentication is required.');
    }

    const token = authorization.slice('Bearer '.length);
    if (!token || token.length > 4096 || token.includes(' ')) {
      throw new UnauthorizedException('Authentication is required.');
    }
    return token;
  }
}
