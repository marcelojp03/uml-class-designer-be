import { HttpException, HttpStatus, Injectable, OnApplicationShutdown } from '@nestjs/common';
import { SPRING_BOOT_EXPORT_LIMITS } from '../generation/spring-boot-export';

const ACTOR_CLEANUP_INTERVAL_MS = Math.min(SPRING_BOOT_EXPORT_LIMITS.actorWindowMs, 10_000);
const MAX_TRACKED_ACTORS = 10_000;

@Injectable()
export class SpringBootExportQuotaService implements OnApplicationShutdown {
  private readonly actorRequests = new Map<string, number[]>();
  private readonly cleanupTimer: NodeJS.Timeout;
  private activeExports = 0;

  constructor() {
    this.cleanupTimer = setInterval(
      () => this.pruneExpiredActorRequests(Date.now()),
      ACTOR_CLEANUP_INTERVAL_MS,
    );
    this.cleanupTimer.unref();
  }

  acquire(actorId: string): () => void {
    const now = Date.now();
    this.pruneExpiredActorRequests(now);
    const requests = this.actorRequests.get(actorId) ?? [];
    if (requests.length >= SPRING_BOOT_EXPORT_LIMITS.actorLimit) {
      throw limitExceeded('EXPORT_RATE_LIMITED', 'Spring Boot export rate limit exceeded.');
    }
    if (this.activeExports >= SPRING_BOOT_EXPORT_LIMITS.maxConcurrentExports) {
      throw limitExceeded(
        'EXPORT_CONCURRENCY_LIMITED',
        'Spring Boot export concurrency limit exceeded.',
      );
    }
    if (!this.actorRequests.has(actorId) && this.actorRequests.size >= MAX_TRACKED_ACTORS) {
      throw limitExceeded(
        'EXPORT_RATE_LIMITED',
        'Spring Boot export rate tracking capacity reached.',
      );
    }

    requests.push(now);
    this.actorRequests.set(actorId, requests);
    this.activeExports += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeExports = Math.max(0, this.activeExports - 1);
    };
  }

  onApplicationShutdown(): void {
    clearInterval(this.cleanupTimer);
    this.actorRequests.clear();
    this.activeExports = 0;
  }

  private pruneExpiredActorRequests(now: number): void {
    const windowStart = now - SPRING_BOOT_EXPORT_LIMITS.actorWindowMs;
    for (const [actorId, requests] of this.actorRequests) {
      const activeRequests = requests.filter((timestamp) => timestamp > windowStart);
      if (activeRequests.length === 0) {
        this.actorRequests.delete(actorId);
      } else if (activeRequests.length !== requests.length) {
        this.actorRequests.set(actorId, activeRequests);
      }
    }
  }
}

function limitExceeded(code: string, message: string): HttpException {
  return new HttpException({ code, message }, HttpStatus.TOO_MANY_REQUESTS);
}
