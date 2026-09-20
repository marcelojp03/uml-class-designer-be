import { HttpException, HttpStatus } from '@nestjs/common';
import { SPRING_BOOT_EXPORT_LIMITS } from '../generation/spring-boot-export';
import { SpringBootExportQuotaService } from './spring-boot-export-quota.service';

function expectTooManyRequests(action: () => void, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(HttpException);
    const response = error as HttpException;
    expect(response.getStatus()).toBe(HttpStatus.TOO_MANY_REQUESTS);
    expect(response.getResponse()).toMatchObject({ code });
    return;
  }
  throw new Error('Expected export quota to reject the request.');
}

describe('SpringBootExportQuotaService', () => {
  it('enforces concurrent export and per-actor rate limits', () => {
    const quota = new SpringBootExportQuotaService();
    const first = quota.acquire('first-actor');
    const second = quota.acquire('second-actor');

    expectTooManyRequests(() => quota.acquire('third-actor'), 'EXPORT_CONCURRENCY_LIMITED');
    first();
    second();

    for (let index = 0; index < 5; index += 1) {
      quota.acquire('rate-limited-actor')();
    }
    expectTooManyRequests(() => quota.acquire('rate-limited-actor'), 'EXPORT_RATE_LIMITED');
    quota.onApplicationShutdown();
  });

  it('expires inactive actor tracking on the bounded cleanup interval', () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-09-20T00:00:00.000Z'));
    const quota = new SpringBootExportQuotaService();
    quota.acquire('expired-actor')();

    expect(Reflect.get(quota, 'actorRequests')).toBeInstanceOf(Map);
    jest.advanceTimersByTime(SPRING_BOOT_EXPORT_LIMITS.actorWindowMs + 10_000);
    expect((Reflect.get(quota, 'actorRequests') as Map<string, number[]>).size).toBe(0);

    quota.onApplicationShutdown();
    jest.useRealTimers();
  });
});
