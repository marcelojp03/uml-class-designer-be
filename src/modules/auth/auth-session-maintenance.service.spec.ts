import type { ConfigService } from '@nestjs/config';
import type { PrismaService } from '../database/prisma.service';
import { AuthSessionMaintenanceService } from './auth-session-maintenance.service';

describe('AuthSessionMaintenanceService', () => {
  it('drains expired-session batches before scheduling recurring cleanup', async () => {
    const executeRaw = jest
      .fn()
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    const service = new AuthSessionMaintenanceService(
      { $executeRaw: executeRaw } as unknown as PrismaService,
      {
        getOrThrow: jest.fn().mockReturnValue({
          auth: { sessionCleanupIntervalMs: 3_600_000, sessionCleanupBatchSize: 2 },
        }),
      } as unknown as ConfigService,
    );
    await service.onModuleInit();
    service.onModuleDestroy();

    expect(executeRaw).toHaveBeenCalledTimes(3);
  });
});
