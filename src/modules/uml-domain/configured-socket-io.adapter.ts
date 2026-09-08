import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import type { Server, ServerOptions } from 'socket.io';
import type { AppConfiguration } from '../../config/app.config';

export class ConfiguredSocketIoAdapter extends IoAdapter {
  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfiguration,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    return super.createIOServer(port, {
      ...options,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, allowed: boolean) => void,
      ) => {
        const origin = request.headers.origin;
        const allowed = typeof origin === 'string' && this.config.corsOrigins.includes(origin);
        callback(null, allowed);
      },
      cors: {
        origin: (
          origin: string | undefined,
          callback: (error: Error | null, allow?: boolean) => void,
        ) => {
          callback(null, origin !== undefined && this.config.corsOrigins.includes(origin));
        },
        credentials: false,
        methods: ['GET', 'POST'],
      },
      maxHttpBufferSize: this.config.collaboration.maxPayloadBytes,
      pingTimeout: this.config.collaboration.pingTimeoutMs,
      pingInterval: this.config.collaboration.pingIntervalMs,
    });
  }
}
