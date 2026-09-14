import { UnauthorizedException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import type { PrismaService } from '../database/prisma.service';
import { AccessTokenVerifierService } from './access-token-verifier.service';

describe('AccessTokenVerifierService', () => {
  it('bounds a stalled session lookup for a handshake', async () => {
    jest.useFakeTimers();
    const pendingSessionLookup = new Promise<never>(() => undefined);
    const findFirst = jest.fn().mockReturnValue(pendingSessionLookup);
    const transaction = jest.fn(async (callback: (client: unknown) => Promise<unknown>) =>
      callback({ authSession: { findFirst } }),
    );
    const service = new AccessTokenVerifierService(
      {
        verifyAsync: jest.fn().mockResolvedValue({
          typ: 'access',
          sub: '11111111-1111-4111-8111-111111111111',
          sid: '22222222-2222-4222-8222-222222222222',
          exp: Math.floor(Date.now() / 1000) + 60,
        }),
      } as unknown as JwtService,
      {
        getOrThrow: jest.fn().mockReturnValue({
          auth: {
            jwtSecret: 'test-only-jwt-secret-never-use-in-production-0123456789012345',
            jwtIssuer: 'test',
            jwtAudience: 'test',
          },
        }),
      } as unknown as ConfigService,
      { $transaction: transaction } as unknown as PrismaService,
    );

    try {
      const verification = service.verify('valid-access-token', { timeoutMs: 10 });
      const rejection = expect(verification).rejects.toBeInstanceOf(UnauthorizedException);

      await jest.advanceTimersByTimeAsync(10);

      await rejection;
      expect(transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 10,
        timeout: 10,
      });
      expect(findFirst).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });
});
