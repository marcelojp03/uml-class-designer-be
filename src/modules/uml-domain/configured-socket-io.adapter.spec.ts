import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { EventEmitter } from 'node:events';
import type { IncomingMessage } from 'node:http';
import type { Server } from 'socket.io';
import type { AppConfiguration } from '../../config/app.config';
import {
  ConfiguredSocketIoAdapter,
  handshakeVerificationTimeoutMs,
  markHandshakeVerificationStarted,
  releaseHandshakeReservation,
} from './configured-socket-io.adapter';

function configuration(): AppConfiguration {
  return {
    nodeEnv: 'test',
    port: 3001,
    host: '127.0.0.1',
    trustProxyHops: 0,
    trustProxyAddresses: [],
    corsOrigins: ['http://localhost:5173'],
    auth: {
      jwtSecret: 'test-only-jwt-secret-never-use-in-production-0123456789012345',
      jwtIssuer: 'test',
      jwtAudience: 'test',
      accessTokenTtlSeconds: 300,
      refreshTokenTtlSeconds: 3600,
      refreshCookieName: 'refresh',
      refreshCookieSecure: false,
      refreshCookieSameSite: 'strict',
      sessionCleanupIntervalMs: 3_600_000,
      sessionCleanupBatchSize: 1000,
    },
    collaboration: {
      maxPayloadBytes: 65_536,
      pingTimeoutMs: 20_000,
      pingIntervalMs: 25_000,
      commandLimit: 30,
      commandWindowMs: 10_000,
      controlEventLimit: 60,
      controlEventWindowMs: 10_000,
      presenceMinIntervalMs: 100,
      lockTtlSeconds: 30,
      maxParticipantsPerDocument: 100,
      maxDocumentsPerSocket: 20,
      maxConnectedSockets: 1000,
      maxSocketsPerSession: 5,
      handshakeLimit: 2,
      handshakeGlobalLimit: 3,
      handshakeWindowMs: 10_000,
      handshakeTimeoutMs: 10_000,
      maxPendingHandshakes: 1,
      maxPendingMutationsPerDocument: 128,
      operationRecoveryIntervalMs: 1000,
      operationRecoveryBatchSize: 100,
    },
  };
}

function request(address: string, forwardedFor?: string): IncomingMessage {
  return {
    headers: {
      origin: 'http://localhost:5173',
      ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
    },
    socket: Object.assign(new EventEmitter(), { remoteAddress: address }),
  } as unknown as IncomingMessage;
}

describe('ConfiguredSocketIoAdapter', () => {
  it('bounds pending and repeated handshake verification work before gateway authentication', () => {
    const adapter = new ConfiguredSocketIoAdapter({} as INestApplicationContext, configuration());
    const internals = adapter as unknown as {
      reserveHandshake: (request: IncomingMessage) => boolean;
    };
    const first = request('198.51.100.10');
    const second = request('198.51.100.11');

    expect(internals.reserveHandshake(first)).toBe(true);
    expect(internals.reserveHandshake(second)).toBe(false);
    releaseHandshakeReservation(first);
    expect(internals.reserveHandshake(second)).toBe(true);
    releaseHandshakeReservation(second);

    const retry = request('198.51.100.10');
    expect(internals.reserveHandshake(retry)).toBe(true);
    releaseHandshakeReservation(retry);
    expect(internals.reserveHandshake(request('198.51.100.10'))).toBe(false);
  });

  it('uses forwarded addresses only from configured reverse proxies', () => {
    const config = configuration();
    config.trustProxyHops = 1;
    config.trustProxyAddresses = ['127.0.0.1'];
    const adapter = new ConfiguredSocketIoAdapter({} as INestApplicationContext, config);
    const internals = adapter as unknown as {
      clientAddress: (request: IncomingMessage) => string;
    };

    expect(internals.clientAddress(request('198.51.100.10', '203.0.113.20'))).toBe('198.51.100.10');
    expect(internals.clientAddress(request('::ffff:127.0.0.1', '203.0.113.20'))).toBe(
      '203.0.113.20',
    );
    expect(
      internals.clientAddress(request('::ffff:127.0.0.1', '203.0.113.20, 198.51.100.10')),
    ).toBe('127.0.0.1');

    config.trustProxyHops = 2;
    expect(internals.clientAddress(request('::ffff:127.0.0.1', '203.0.113.20'))).toBe('127.0.0.1');
  });

  it('releases stalled Engine.IO handshake reservations when the transport closes', () => {
    const engine = new EventEmitter();
    const server = { engine } as unknown as Server;
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue(server);
    try {
      const adapter = new ConfiguredSocketIoAdapter({} as INestApplicationContext, configuration());
      const internals = adapter as unknown as {
        reserveHandshake: (request: IncomingMessage) => boolean;
      };
      const first = request('198.51.100.10');
      const second = request('198.51.100.11');

      adapter.createIOServer(0);
      expect(createIOServer).toHaveBeenCalledWith(
        0,
        expect.objectContaining({ connectTimeout: 10_000 }),
      );
      expect(internals.reserveHandshake(first)).toBe(true);
      const connection = Object.assign(new EventEmitter(), { request: first });
      engine.emit('connection', connection);
      connection.emit('close');

      expect(internals.reserveHandshake(second)).toBe(true);
      releaseHandshakeReservation(second);
    } finally {
      createIOServer.mockRestore();
    }
  });

  it('force-closes a polling transport that never starts Socket.IO authentication', () => {
    jest.useFakeTimers();
    const engine = new EventEmitter();
    const server = { engine } as unknown as Server;
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue(server);
    try {
      const config = configuration();
      config.collaboration.handshakeTimeoutMs = 10;
      const adapter = new ConfiguredSocketIoAdapter({} as INestApplicationContext, config);
      const internals = adapter as unknown as {
        reserveHandshake: (request: IncomingMessage) => boolean;
      };
      const first = request('198.51.100.10');
      const second = request('198.51.100.11');
      const connection = Object.assign(new EventEmitter(), {
        request: first,
        close: jest.fn(function close(this: EventEmitter) {
          this.emit('close');
        }),
      });

      adapter.createIOServer(0);
      expect(internals.reserveHandshake(first)).toBe(true);
      engine.emit('connection', connection);
      expect(internals.reserveHandshake(second)).toBe(false);

      jest.advanceTimersByTime(10);

      expect(connection.close).toHaveBeenCalledWith(true);
      expect(internals.reserveHandshake(second)).toBe(true);
      releaseHandshakeReservation(second);
    } finally {
      createIOServer.mockRestore();
      jest.useRealTimers();
    }
  });

  it('keeps a pending reservation until active verification is released', () => {
    jest.useFakeTimers();
    const engine = new EventEmitter();
    const server = { engine } as unknown as Server;
    const createIOServer = jest
      .spyOn(IoAdapter.prototype, 'createIOServer')
      .mockReturnValue(server);
    try {
      const config = configuration();
      config.collaboration.handshakeTimeoutMs = 10;
      const adapter = new ConfiguredSocketIoAdapter({} as INestApplicationContext, config);
      const internals = adapter as unknown as {
        reserveHandshake: (request: IncomingMessage) => boolean;
      };
      const first = request('198.51.100.10');
      const second = request('198.51.100.11');
      const connection = Object.assign(new EventEmitter(), {
        request: first,
        close: jest.fn(function close(this: EventEmitter) {
          this.emit('close');
        }),
      });

      adapter.createIOServer(0);
      expect(internals.reserveHandshake(first)).toBe(true);
      engine.emit('connection', connection);
      markHandshakeVerificationStarted(first);
      expect(handshakeVerificationTimeoutMs(first, 1_000)).toBe(10);

      jest.advanceTimersByTime(10);

      expect(connection.close).toHaveBeenCalledWith(true);
      expect(internals.reserveHandshake(second)).toBe(false);
      releaseHandshakeReservation(first);
      expect(internals.reserveHandshake(second)).toBe(true);
      releaseHandshakeReservation(second);
    } finally {
      createIOServer.mockRestore();
      jest.useRealTimers();
    }
  });
});
