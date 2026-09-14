import type { INestApplicationContext } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import type { IncomingMessage } from 'node:http';
import { isIP } from 'node:net';
import type { Server, ServerOptions } from 'socket.io';
import { normalizeNetworkAddress, type AppConfiguration } from '../../config/app.config';

const handshakeReservation = Symbol('handshakeReservation');

type HandshakeReservation = {
  deadlineAt: number;
  verificationStarted: boolean;
  release: () => void;
  connection?: EngineConnection;
};
type HandshakeRequest = IncomingMessage & { [handshakeReservation]?: HandshakeReservation };
type EngineConnection = {
  request: IncomingMessage;
  close(discard?: boolean): unknown;
  once(event: 'close', listener: () => void): unknown;
};

export function releaseHandshakeReservation(request: IncomingMessage): void {
  (request as HandshakeRequest)[handshakeReservation]?.release();
}

export function markHandshakeVerificationStarted(request: IncomingMessage): void {
  const reservation = (request as HandshakeRequest)[handshakeReservation];
  if (reservation) {
    reservation.verificationStarted = true;
  }
}

export function handshakeVerificationTimeoutMs(
  request: IncomingMessage,
  fallbackTimeoutMs: number,
): number {
  const reservation = (request as HandshakeRequest)[handshakeReservation];
  return reservation ? Math.max(1, reservation.deadlineAt - Date.now()) : fallbackTimeoutMs;
}

export class ConfiguredSocketIoAdapter extends IoAdapter {
  private readonly handshakeAttemptsByClient = new Map<string, number>();
  private handshakeWindowStartedAt = 0;
  private handshakeAttempts = 0;
  private pendingHandshakes = 0;

  constructor(
    app: INestApplicationContext,
    private readonly config: AppConfiguration,
  ) {
    super(app);
  }

  createIOServer(port: number, options?: ServerOptions): Server {
    const server = super.createIOServer(port, {
      ...options,
      allowRequest: (
        request: IncomingMessage,
        callback: (error: string | null | undefined, allowed: boolean) => void,
      ) => {
        const origin = request.headers.origin;
        const allowed =
          typeof origin === 'string' &&
          this.config.corsOrigins.includes(origin) &&
          this.reserveHandshake(request);
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
      connectTimeout: this.config.collaboration.handshakeTimeoutMs,
    });
    server.engine.on('connection', (connection: EngineConnection) => {
      const reservation = this.handshakeReservationFor(connection.request);
      if (!reservation) {
        return;
      }
      reservation.connection = connection;
      connection.once('close', () => {
        // Keep the admission slot while bounded verifier work is still active.
        if (!reservation.verificationStarted) {
          reservation.release();
        }
      });
    });
    return server;
  }

  private reserveHandshake(request: IncomingMessage): boolean {
    const now = Date.now();
    const collaboration = this.config.collaboration;
    if (now - this.handshakeWindowStartedAt >= collaboration.handshakeWindowMs) {
      this.handshakeWindowStartedAt = now;
      this.handshakeAttempts = 0;
      this.handshakeAttemptsByClient.clear();
    }

    const clientAddress = this.clientAddress(request);
    const clientAttempts = this.handshakeAttemptsByClient.get(clientAddress) ?? 0;
    if (
      this.handshakeAttempts >= collaboration.handshakeGlobalLimit ||
      clientAttempts >= collaboration.handshakeLimit ||
      this.pendingHandshakes >= collaboration.maxPendingHandshakes
    ) {
      return false;
    }

    this.handshakeAttempts += 1;
    this.handshakeAttemptsByClient.set(clientAddress, clientAttempts + 1);
    this.pendingHandshakes += 1;
    const handshakeRequest = request as HandshakeRequest;
    let timeout: NodeJS.Timeout | undefined;
    const reservation: HandshakeReservation = {
      deadlineAt: now + collaboration.handshakeTimeoutMs,
      verificationStarted: false,
      release: () => {
        if (handshakeRequest[handshakeReservation] !== reservation) {
          return;
        }
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        this.pendingHandshakes -= 1;
        handshakeRequest.socket.off('close', releaseAbortedRequest);
        handshakeRequest[handshakeReservation] = undefined;
      },
    };
    const releaseAbortedRequest = () => {
      if (!reservation.connection && !reservation.verificationStarted) {
        reservation.release();
      }
    };
    timeout = setTimeout(() => {
      if (reservation.connection) {
        reservation.connection.close(true);
      } else {
        handshakeRequest.socket.destroy();
      }
      if (!reservation.verificationStarted) {
        reservation.release();
      }
    }, collaboration.handshakeTimeoutMs);
    timeout.unref();
    handshakeRequest[handshakeReservation] = reservation;
    handshakeRequest.socket.once('close', releaseAbortedRequest);
    return true;
  }

  private handshakeReservationFor(request: IncomingMessage): HandshakeReservation | undefined {
    return (request as HandshakeRequest)[handshakeReservation];
  }

  private clientAddress(request: IncomingMessage): string {
    const remoteAddress = normalizeNetworkAddress(request.socket.remoteAddress ?? 'unknown');
    const forwardedFor = request.headers['x-forwarded-for'];
    if (
      this.config.trustProxyHops === 1 &&
      this.isTrustedProxy(remoteAddress) &&
      typeof forwardedFor === 'string'
    ) {
      const forwardedAddress = normalizeNetworkAddress(forwardedFor.trim());
      if (!forwardedFor.includes(',') && isIP(forwardedAddress) !== 0) {
        return forwardedAddress;
      }
    }
    return remoteAddress;
  }

  private isTrustedProxy(address: string | undefined): boolean {
    return (
      address !== undefined &&
      this.config.trustProxyAddresses.includes(normalizeNetworkAddress(address))
    );
  }
}
