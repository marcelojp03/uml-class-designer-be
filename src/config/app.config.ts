import { registerAs } from '@nestjs/config';

export const LOCAL_DEVELOPMENT_JWT_SECRET =
  'development-only-jwt-secret-change-before-production-0123456789';
export const TEST_JWT_SECRET = 'test-only-jwt-secret-never-use-in-production-0123456789012345';

export type RefreshCookieSameSite = 'strict' | 'lax' | 'none';

export function normalizeNetworkAddress(address: string): string {
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address;
}

export interface AuthConfiguration {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshCookieName: string;
  refreshCookieSecure: boolean;
  refreshCookieSameSite: RefreshCookieSameSite;
  sessionCleanupIntervalMs: number;
  sessionCleanupBatchSize: number;
}

export interface CollaborationConfiguration {
  maxPayloadBytes: number;
  pingTimeoutMs: number;
  pingIntervalMs: number;
  commandLimit: number;
  commandWindowMs: number;
  controlEventLimit: number;
  controlEventWindowMs: number;
  presenceMinIntervalMs: number;
  lockTtlSeconds: number;
  maxParticipantsPerDocument: number;
  maxDocumentsPerSocket: number;
  maxConnectedSockets: number;
  maxSocketsPerSession: number;
  handshakeLimit: number;
  handshakeGlobalLimit: number;
  handshakeWindowMs: number;
  handshakeTimeoutMs: number;
  maxPendingHandshakes: number;
  maxPendingMutationsPerDocument: number;
  operationRecoveryIntervalMs: number;
  operationRecoveryBatchSize: number;
}

export interface AppConfiguration {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  trustProxyHops: number;
  trustProxyAddresses: string[];
  corsOrigins: string[];
  auth: AuthConfiguration;
  collaboration: CollaborationConfiguration;
}

export default registerAs('app', (): AppConfiguration => {
  const nodeEnv = process.env.NODE_ENV as AppConfiguration['nodeEnv'];

  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
    host: process.env.HOST ?? '127.0.0.1',
    trustProxyHops: Number(process.env.TRUST_PROXY_HOPS ?? 0),
    trustProxyAddresses: (process.env.TRUST_PROXY_ADDRESSES ?? '')
      .split(',')
      .map((address) => normalizeNetworkAddress(address.trim()))
      .filter(Boolean),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    auth: {
      jwtSecret: process.env.AUTH_JWT_SECRET as string,
      jwtIssuer: process.env.AUTH_JWT_ISSUER ?? 'uml-class-designer-be',
      jwtAudience: process.env.AUTH_JWT_AUDIENCE ?? 'uml-class-designer',
      accessTokenTtlSeconds: Number(process.env.AUTH_ACCESS_TOKEN_TTL_SECONDS ?? 900),
      refreshTokenTtlSeconds: Number(process.env.AUTH_REFRESH_TOKEN_TTL_SECONDS ?? 1_209_600),
      refreshCookieName: process.env.AUTH_REFRESH_COOKIE_NAME ?? 'uml_refresh',
      refreshCookieSecure:
        process.env.AUTH_REFRESH_COOKIE_SECURE === undefined
          ? nodeEnv === 'production'
          : process.env.AUTH_REFRESH_COOKIE_SECURE.toLowerCase() === 'true',
      refreshCookieSameSite: (process.env.AUTH_REFRESH_COOKIE_SAME_SITE ??
        'strict') as RefreshCookieSameSite,
      sessionCleanupIntervalMs: Number(process.env.AUTH_SESSION_CLEANUP_INTERVAL_MS ?? 3_600_000),
      sessionCleanupBatchSize: Number(process.env.AUTH_SESSION_CLEANUP_BATCH_SIZE ?? 1000),
    },
    collaboration: {
      maxPayloadBytes: Number(process.env.COLLABORATION_SOCKET_MAX_PAYLOAD_BYTES ?? 65_536),
      pingTimeoutMs: Number(process.env.COLLABORATION_PING_TIMEOUT_MS ?? 20_000),
      pingIntervalMs: Number(process.env.COLLABORATION_PING_INTERVAL_MS ?? 25_000),
      commandLimit: Number(process.env.COLLABORATION_COMMAND_LIMIT ?? 30),
      commandWindowMs: Number(process.env.COLLABORATION_COMMAND_WINDOW_MS ?? 10_000),
      controlEventLimit: Number(process.env.COLLABORATION_CONTROL_EVENT_LIMIT ?? 60),
      controlEventWindowMs: Number(process.env.COLLABORATION_CONTROL_EVENT_WINDOW_MS ?? 10_000),
      presenceMinIntervalMs: Number(process.env.COLLABORATION_PRESENCE_MIN_INTERVAL_MS ?? 100),
      lockTtlSeconds: Number(process.env.COLLABORATION_LOCK_TTL_SECONDS ?? 30),
      maxParticipantsPerDocument: Number(
        process.env.COLLABORATION_MAX_PARTICIPANTS_PER_DOCUMENT ?? 100,
      ),
      maxDocumentsPerSocket: Number(process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET ?? 20),
      maxConnectedSockets: Number(process.env.COLLABORATION_MAX_CONNECTED_SOCKETS ?? 1000),
      maxSocketsPerSession: Number(process.env.COLLABORATION_MAX_SOCKETS_PER_SESSION ?? 5),
      handshakeLimit: Number(process.env.COLLABORATION_HANDSHAKE_LIMIT ?? 30),
      handshakeGlobalLimit: Number(process.env.COLLABORATION_HANDSHAKE_GLOBAL_LIMIT ?? 200),
      handshakeWindowMs: Number(process.env.COLLABORATION_HANDSHAKE_WINDOW_MS ?? 10_000),
      handshakeTimeoutMs: Number(process.env.COLLABORATION_HANDSHAKE_TIMEOUT_MS ?? 10_000),
      maxPendingHandshakes: Number(process.env.COLLABORATION_MAX_PENDING_HANDSHAKES ?? 32),
      maxPendingMutationsPerDocument: Number(
        process.env.COLLABORATION_MAX_PENDING_MUTATIONS_PER_DOCUMENT ?? 128,
      ),
      operationRecoveryIntervalMs: Number(
        process.env.COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS ?? 1000,
      ),
      operationRecoveryBatchSize: Number(
        process.env.COLLABORATION_OPERATION_RECOVERY_BATCH_SIZE ?? 100,
      ),
    },
  };
});
