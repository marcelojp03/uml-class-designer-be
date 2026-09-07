import { ConflictException, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { isUUID } from 'class-validator';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { argon2id, hash as hashPassword, verify as verifyPassword } from 'argon2';
import type { AppConfiguration } from '../../config/app.config';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { LoginDto, RegisterDto } from './dto/auth.dto';
import type { AuthResult, SafeUser } from './auth.types';

const SAFE_USER_SELECT = { id: true, email: true, displayName: true } satisfies Prisma.UserSelect;
type SelectedUser = Prisma.UserGetPayload<{ select: typeof SAFE_USER_SELECT }>;

const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,p=1,t=2$itoy0/WJ82GRUBcp9drOYA$f+1s4dfv3reO0lTQhPcyfn+VT5bADodp9cIHmpG1iLI';
const PASSWORD_HASH_OPTIONS = {
  type: argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
} as const;

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService,
  ) {}

  async register(input: RegisterDto): Promise<AuthResult> {
    const passwordHash = await hashPassword(input.password, PASSWORD_HASH_OPTIONS);
    const session = this.newSessionToken();
    const expiresAt = this.refreshExpiry();

    let user: SelectedUser;
    try {
      user = await this.prisma.$transaction(async (transaction) => {
        const createdUser = await transaction.user.create({
          data: {
            email: this.normalizeEmail(input.email),
            displayName: input.displayName.trim(),
            passwordHash,
          },
          select: SAFE_USER_SELECT,
        });
        await transaction.authSession.create({
          data: {
            id: session.id,
            userId: createdUser.id,
            tokenHash: this.hashRefreshToken(session.token),
            expiresAt,
          },
        });
        return createdUser;
      });
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('Unable to create account with the provided credentials.');
      }
      throw error;
    }

    return this.buildAuthResult(user, session.id, session.token, expiresAt);
  }

  async login(input: LoginDto): Promise<AuthResult> {
    const normalizedEmail = this.normalizeEmail(input.email);
    const user = await this.prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { ...SAFE_USER_SELECT, passwordHash: true },
    });
    const passwordMatches = await verifyPassword(
      user?.passwordHash ?? DUMMY_PASSWORD_HASH,
      input.password,
    );
    if (!user || !passwordMatches) {
      throw new UnauthorizedException('Invalid email or password.');
    }

    const session = this.newSessionToken();
    const expiresAt = this.refreshExpiry();
    await this.prisma.authSession.create({
      data: {
        id: session.id,
        userId: user.id,
        tokenHash: this.hashRefreshToken(session.token),
        expiresAt,
      },
    });

    return this.buildAuthResult(user, session.id, session.token, expiresAt);
  }

  async refresh(refreshToken: string | undefined): Promise<AuthResult> {
    const parsedToken = this.parseRefreshToken(refreshToken);
    if (!parsedToken) {
      throw new UnauthorizedException('Refresh session is invalid or expired.');
    }

    const nextSession = this.newSessionToken(parsedToken.sessionId);
    const presentedHash = this.hashRefreshToken(parsedToken.token);
    const nextHash = this.hashRefreshToken(nextSession.token);
    const rotated = await this.prisma.$queryRaw<Array<{ sessionId: string }>>(Prisma.sql`
      WITH rotated AS (
        UPDATE "AuthSession"
        SET "tokenHash" = ${nextHash}, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = CAST(${parsedToken.sessionId} AS UUID)
          AND "tokenHash" = ${presentedHash}
          AND "revokedAt" IS NULL
          AND "expiresAt" > CURRENT_TIMESTAMP
        RETURNING "id"
      )
      INSERT INTO "ConsumedRefreshToken" ("tokenHash", "sessionId", "consumedAt")
      SELECT ${presentedHash}, "id", CURRENT_TIMESTAMP FROM rotated
      RETURNING "sessionId"
    `);

    if (rotated.length !== 1) {
      await this.revokeReplayedSession(parsedToken.sessionId, presentedHash);
      throw new UnauthorizedException('Refresh session is invalid or expired.');
    }

    const session = await this.prisma.authSession.findUnique({
      where: { id: parsedToken.sessionId },
      select: { id: true, expiresAt: true, user: { select: SAFE_USER_SELECT } },
    });
    if (!session) {
      throw new UnauthorizedException('Refresh session is invalid or expired.');
    }
    return this.buildAuthResult(session.user, session.id, nextSession.token, session.expiresAt);
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    const parsedToken = this.parseRefreshToken(refreshToken);
    if (!parsedToken) {
      return;
    }

    const presentedHash = this.hashRefreshToken(parsedToken.token);
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "AuthSession" AS session
      SET "revokedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE session."id" = CAST(${parsedToken.sessionId} AS UUID)
        AND session."revokedAt" IS NULL
        AND (
          session."tokenHash" = ${presentedHash}
          OR EXISTS (
            SELECT 1 FROM "ConsumedRefreshToken" consumed
            WHERE consumed."sessionId" = session."id"
              AND consumed."tokenHash" = ${presentedHash}
          )
        )
    `);
  }

  private async buildAuthResult(
    user: SelectedUser,
    sessionId: string,
    refreshToken: string,
    refreshExpiresAt: Date,
  ): Promise<AuthResult> {
    const config = this.configService.getOrThrow<AppConfiguration>('app');
    const accessToken = await this.jwtService.signAsync(
      { sub: user.id, sid: sessionId, typ: 'access' },
      {
        secret: config.auth.jwtSecret,
        algorithm: 'HS256',
        issuer: config.auth.jwtIssuer,
        audience: config.auth.jwtAudience,
        expiresIn: config.auth.accessTokenTtlSeconds,
      },
    );

    return {
      accessToken,
      expiresIn: config.auth.accessTokenTtlSeconds,
      user: this.toSafeUser(user),
      refreshToken,
      refreshExpiresAt,
    };
  }

  private newSessionToken(sessionId: string = randomUUID()): { id: string; token: string } {
    const secret = randomBytes(32).toString('base64url');
    return { id: sessionId, token: `${sessionId}.${secret}` };
  }

  private parseRefreshToken(
    value: string | undefined,
  ): { sessionId: string; token: string } | null {
    if (!value || value.length > 256) {
      return null;
    }
    const [sessionId, secret, extra] = value.split('.');
    if (!sessionId || !secret || extra || !isUUID(sessionId, '4')) {
      return null;
    }
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) {
      return null;
    }
    return { sessionId, token: value };
  }

  private refreshExpiry(): Date {
    const config = this.configService.getOrThrow<AppConfiguration>('app');
    return new Date(Date.now() + config.auth.refreshTokenTtlSeconds * 1000);
  }

  private hashRefreshToken(token: string): string {
    return createHash('sha256').update(token, 'utf8').digest('hex');
  }

  private async revokeReplayedSession(sessionId: string, tokenHash: string): Promise<void> {
    await this.prisma.$executeRaw(Prisma.sql`
      UPDATE "AuthSession" AS session
      SET "revokedAt" = CURRENT_TIMESTAMP, "updatedAt" = CURRENT_TIMESTAMP
      WHERE session."id" = CAST(${sessionId} AS UUID)
        AND session."revokedAt" IS NULL
        AND EXISTS (
          SELECT 1 FROM "ConsumedRefreshToken" consumed
          WHERE consumed."sessionId" = session."id"
            AND consumed."tokenHash" = ${tokenHash}
        )
    `);
  }

  private normalizeEmail(email: string): string {
    return email.trim().toLowerCase();
  }

  private toSafeUser(user: SelectedUser): SafeUser {
    return { id: user.id, email: user.email, displayName: user.displayName };
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
