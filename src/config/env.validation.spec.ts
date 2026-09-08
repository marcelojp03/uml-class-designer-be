import appConfig, { LOCAL_DEVELOPMENT_JWT_SECRET, TEST_JWT_SECRET } from './app.config';
import { envValidationSchema } from './env.validation';

const baseProductionEnvironment = {
  NODE_ENV: 'production',
  TRUST_PROXY_HOPS: 1,
  DATABASE_URL: 'postgresql://user:password@localhost:5432/database',
  CORS_ORIGINS: 'https://designer.example.com',
  AUTH_JWT_SECRET: 'production-secret-with-at-least-thirty-two-characters',
  AUTH_REFRESH_COOKIE_SECURE: true,
};

describe('environment validation', () => {
  it('rejects the local JWT secret in production', () => {
    const result = envValidationSchema.validate({
      ...baseProductionEnvironment,
      AUTH_JWT_SECRET: LOCAL_DEVELOPMENT_JWT_SECRET,
    });
    expect(result.error).toBeDefined();
  });

  it('rejects the committed test JWT secret in production', () => {
    const result = envValidationSchema.validate({
      ...baseProductionEnvironment,
      AUTH_JWT_SECRET: TEST_JWT_SECRET,
    });
    expect(result.error).toBeDefined();
  });

  it.each(['NODE_ENV', 'DATABASE_URL', 'AUTH_JWT_SECRET'] as const)(
    'requires %s instead of silently selecting a local default',
    (variable) => {
      const environment: Record<string, unknown> = { ...baseProductionEnvironment };
      delete environment[variable];
      expect(envValidationSchema.validate(environment).error).toBeDefined();
    },
  );

  it('requires secure refresh cookies in production', () => {
    const result = envValidationSchema.validate({
      ...baseProductionEnvironment,
      AUTH_REFRESH_COOKIE_SECURE: false,
    });
    expect(result.error).toBeDefined();
  });

  it('requires an explicit trusted proxy hop count in production', () => {
    const result = envValidationSchema.validate({
      ...baseProductionEnvironment,
      TRUST_PROXY_HOPS: 0,
    });
    expect(result.error).toBeDefined();
  });

  it.each(['*', 'https://designer.example.com, *', 'ftp://designer.example.com', 'not-an-origin'])(
    'rejects unsafe CORS_ORIGINS value %s',
    (corsOrigins) => {
      expect(
        envValidationSchema.validate({ ...baseProductionEnvironment, CORS_ORIGINS: corsOrigins })
          .error,
      ).toBeDefined();
    },
  );

  it('accepts an explicit production secret and secure cookie', () => {
    const result = envValidationSchema.validate(baseProductionEnvironment);
    expect(result.error).toBeUndefined();
  });

  it('uses the same case-insensitive secure-cookie value accepted by validation', () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousSecret = process.env.AUTH_JWT_SECRET;
    const previousSecure = process.env.AUTH_REFRESH_COOKIE_SECURE;
    try {
      process.env.NODE_ENV = 'production';
      process.env.AUTH_JWT_SECRET = baseProductionEnvironment.AUTH_JWT_SECRET;
      process.env.AUTH_REFRESH_COOKIE_SECURE = 'TRUE';
      expect(appConfig().auth.refreshCookieSecure).toBe(true);
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousSecret === undefined) delete process.env.AUTH_JWT_SECRET;
      else process.env.AUTH_JWT_SECRET = previousSecret;
      if (previousSecure === undefined) delete process.env.AUTH_REFRESH_COOKIE_SECURE;
      else process.env.AUTH_REFRESH_COOKIE_SECURE = previousSecure;
    }
  });
});
