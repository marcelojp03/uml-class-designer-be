import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import type { AppConfiguration } from '../../config/app.config';
import { PrismaService } from '../database/prisma.service';

@Injectable()
export class AuthSessionMaintenanceService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuthSessionMaintenanceService.name);
  private cleanupTimer?: NodeJS.Timeout;
  private cleanupInFlight = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.removeExpiredSessions();
    this.cleanupTimer = setInterval(() => {
      void this.removeExpiredSessions();
    }, this.config().sessionCleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  onModuleDestroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }

  private async removeExpiredSessions(): Promise<void> {
    if (this.cleanupInFlight) {
      return;
    }
    this.cleanupInFlight = true;
    try {
      const batchSize = this.config().sessionCleanupBatchSize;
      let deleted: number;
      do {
        deleted = await this.prisma.$executeRaw(Prisma.sql`
          DELETE FROM "AuthSession"
          WHERE "id" IN (
            SELECT "id"
            FROM "AuthSession"
            WHERE "expiresAt" <= CURRENT_TIMESTAMP
            ORDER BY "expiresAt" ASC
            LIMIT ${batchSize}
          )
        `);
      } while (deleted === batchSize);
    } catch {
      this.logger.error('Expired authentication session cleanup failed.');
    } finally {
      this.cleanupInFlight = false;
    }
  }

  private config(): AppConfiguration['auth'] {
    return this.configService.getOrThrow<AppConfiguration>('app').auth;
  }
}
