import { Injectable, OnApplicationShutdown, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { Prisma } from '@prisma/client';
import { isUUID } from 'class-validator';
import { EventEmitter } from 'node:events';
import type { AppConfiguration } from '../../config/app.config';
import { PrismaService } from '../database/prisma.service';
import type { AccessTokenClaims, AuthenticatedPrincipal, SafeUser } from './auth.types';

interface AccessTokenVerificationOptions {
  timeoutMs?: number;
}

interface ActiveSession {
  id: string;
  user: SafeUser;
}

@Injectable()
export class AccessTokenVerifierService implements OnApplicationShutdown {
  private readonly sessionRevocations = new EventEmitter();

  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  async verify(
    token: string,
    options: AccessTokenVerificationOptions = {},
  ): Promise<AuthenticatedPrincipal> {
    if (options.timeoutMs === undefined) {
      return this.verifyAccessToken(token);
    }
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
    return this.withTimeout(this.verifyAccessToken(token, timeoutMs), timeoutMs);
  }

  private async verifyAccessToken(
    token: string,
    timeoutMs?: number,
  ): Promise<AuthenticatedPrincipal> {
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

    if (
      payload.typ !== 'access' ||
      !isUUID(payload.sub, '4') ||
      !isUUID(payload.sid, '4') ||
      !Number.isSafeInteger(payload.exp) ||
      payload.exp <= Math.floor(Date.now() / 1000)
    ) {
      throw new UnauthorizedException('Authentication is required.');
    }

    const session = await this.findActiveSession(payload, timeoutMs);
    if (!session) {
      throw new UnauthorizedException('Authentication is required.');
    }

    return { ...session.user, sessionId: session.id, accessTokenExpiresAt: payload.exp };
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

  async lockActiveSession(
    transaction: Prisma.TransactionClient,
    userId: string,
    sessionId: string,
  ): Promise<boolean> {
    if (!isUUID(userId, '4') || !isUUID(sessionId, '4')) {
      return false;
    }
    const sessions = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "AuthSession"
      WHERE "id" = CAST(${sessionId} AS UUID)
        AND "userId" = CAST(${userId} AS UUID)
        AND "revokedAt" IS NULL
        AND "expiresAt" > ${new Date()}
      FOR UPDATE
    `);
    return sessions.length === 1;
  }

  notifySessionRevoked(sessionId: string): void {
    if (isUUID(sessionId, '4')) {
      this.sessionRevocations.emit('revoked', sessionId);
    }
  }

  onSessionRevoked(listener: (sessionId: string) => void): () => void {
    this.sessionRevocations.on('revoked', listener);
    return () => this.sessionRevocations.off('revoked', listener);
  }

  onApplicationShutdown(): void {
    this.sessionRevocations.removeAllListeners();
  }

  private async findActiveSession(
    payload: AccessTokenClaims,
    timeoutMs?: number,
  ): Promise<ActiveSession | null> {
    const find = (client: Pick<PrismaService, 'authSession'>) =>
      client.authSession.findFirst({
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
    if (timeoutMs === undefined) {
      return (await find(this.prisma)) as ActiveSession | null;
    }

    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    return this.withTimeout(
      this.prisma.$transaction((transaction) => find(transaction), {
        maxWait: boundedTimeoutMs,
        timeout: boundedTimeoutMs,
      }) as Promise<ActiveSession | null>,
      boundedTimeoutMs,
    );
  }

  private async withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
    let timeout: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(
            () => reject(new UnauthorizedException('Authentication is required.')),
            timeoutMs,
          );
          timeout.unref();
        }),
      ]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }
}
