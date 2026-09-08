import { Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import type { AppConfiguration } from '../../config/app.config';
import { PrismaService } from '../database/prisma.service';
import type { AccessTokenClaims, AuthenticatedPrincipal } from './auth.types';

@Injectable()
export class AccessTokenVerifierService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(token: string): Promise<AuthenticatedPrincipal> {
    if (!token || token.length > 4096 || token.includes(' ')) {
      throw new UnauthorizedException('Authentication is required.');
    }

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

    return { ...session.user, sessionId: session.id };
  }

  async isSessionActive(userId: string, sessionId: string): Promise<boolean> {
    if (!isUUID(userId, '4') || !isUUID(sessionId, '4')) {
      return false;
    }

    const session = await this.prisma.authSession.findFirst({
      where: {
        id: sessionId,
        userId,
        revokedAt: null,
        expiresAt: { gt: new Date() },
      },
      select: { id: true },
    });
    return session !== null;
  }
}
