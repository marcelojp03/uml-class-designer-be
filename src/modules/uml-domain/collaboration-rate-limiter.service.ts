import { Injectable, OnApplicationShutdown } from '@nestjs/common';

interface RateWindow {
  startedAt: number;
  count: number;
}

@Injectable()
export class CollaborationRateLimiterService implements OnApplicationShutdown {
  private readonly commandWindows = new Map<string, RateWindow>();
  private readonly controlEventWindows = new Map<string, RateWindow>();

  allowCommand(socketId: string, limit: number, windowMs: number): boolean {
    return this.allow(this.commandWindows, socketId, limit, windowMs);
  }

  allowControlEvent(socketId: string, limit: number, windowMs: number): boolean {
    return this.allow(this.controlEventWindows, socketId, limit, windowMs);
  }

  releaseSocket(socketId: string): void {
    this.commandWindows.delete(socketId);
    this.controlEventWindows.delete(socketId);
  }

  onApplicationShutdown(): void {
    this.commandWindows.clear();
    this.controlEventWindows.clear();
  }

  private allow(
    windows: Map<string, RateWindow>,
    socketId: string,
    limit: number,
    windowMs: number,
  ): boolean {
    const now = Date.now();
    const current = windows.get(socketId);
    if (!current || now - current.startedAt >= windowMs) {
      windows.set(socketId, { startedAt: now, count: 1 });
      return true;
    }
    if (current.count >= limit) {
      return false;
    }
    current.count += 1;
    return true;
  }
}
