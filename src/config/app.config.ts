import { registerAs } from '@nestjs/config';

export const LOCAL_DEVELOPMENT_JWT_SECRET =
  'development-only-jwt-secret-change-before-production-0123456789';
export const TEST_JWT_SECRET = 'test-only-jwt-secret-never-use-in-production-0123456789012345';

export type RefreshCookieSameSite = 'strict' | 'lax' | 'none';

export interface AuthConfiguration {
  jwtSecret: string;
  jwtIssuer: string;
  jwtAudience: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
  refreshCookieName: string;
  refreshCookieSecure: boolean;
  refreshCookieSameSite: RefreshCookieSameSite;
}

export interface CollaborationConfiguration {
  maxPayloadBytes: number;
  pingTimeoutMs: number;
  pingIntervalMs: number;
  commandLimit: number;
  commandWindowMs: number;
  presenceMinIntervalMs: number;
  lockTtlSeconds: number;
  maxParticipantsPerDocument: number;
  maxDocumentsPerSocket: number;
}

export interface AppConfiguration {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  trustProxyHops: number;
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
    },
    collaboration: {
      maxPayloadBytes: Number(process.env.COLLABORATION_SOCKET_MAX_PAYLOAD_BYTES ?? 65_536),
      pingTimeoutMs: Number(process.env.COLLABORATION_PING_TIMEOUT_MS ?? 20_000),
      pingIntervalMs: Number(process.env.COLLABORATION_PING_INTERVAL_MS ?? 25_000),
      commandLimit: Number(process.env.COLLABORATION_COMMAND_LIMIT ?? 30),
      commandWindowMs: Number(process.env.COLLABORATION_COMMAND_WINDOW_MS ?? 10_000),
      presenceMinIntervalMs: Number(process.env.COLLABORATION_PRESENCE_MIN_INTERVAL_MS ?? 100),
      lockTtlSeconds: Number(process.env.COLLABORATION_LOCK_TTL_SECONDS ?? 30),
      maxParticipantsPerDocument: Number(
        process.env.COLLABORATION_MAX_PARTICIPANTS_PER_DOCUMENT ?? 100,
      ),
      maxDocumentsPerSocket: Number(process.env.COLLABORATION_MAX_DOCUMENTS_PER_SOCKET ?? 20),
    },
  };
});
