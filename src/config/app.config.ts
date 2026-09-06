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

export interface AppConfiguration {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  trustProxyHops: number;
  corsOrigins: string[];
  auth: AuthConfiguration;
}

export default registerAs('app', (): AppConfiguration => {
  const nodeEnv = process.env.NODE_ENV as AppConfiguration['nodeEnv'];

  return {
    nodeEnv,
    port: Number(process.env.PORT ?? 3000),
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
  };
});
