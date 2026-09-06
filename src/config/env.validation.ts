import * as Joi from 'joi';
import { LOCAL_DEVELOPMENT_JWT_SECRET, TEST_JWT_SECRET } from './app.config';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().default(3000),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(5).default(0),
  CORS_ORIGINS: Joi.string().default('http://localhost:5173'),
  DATABASE_URL: Joi.string()
    .uri({ scheme: ['postgresql', 'postgres'] })
    .required(),
  AUTH_JWT_SECRET: Joi.string().min(32).required(),
  AUTH_JWT_ISSUER: Joi.string().min(1).default('uml-class-designer-be'),
  AUTH_JWT_AUDIENCE: Joi.string().min(1).default('uml-class-designer'),
  AUTH_ACCESS_TOKEN_TTL_SECONDS: Joi.number().integer().min(60).max(3600).default(900),
  AUTH_REFRESH_TOKEN_TTL_SECONDS: Joi.number().integer().min(300).max(7_776_000).default(1_209_600),
  AUTH_REFRESH_COOKIE_NAME: Joi.string()
    .pattern(/^[A-Za-z0-9_-]+$/)
    .default('uml_refresh'),
  AUTH_REFRESH_COOKIE_SECURE: Joi.boolean().truthy('true').falsy('false').default(false),
  AUTH_REFRESH_COOKIE_SAME_SITE: Joi.string().valid('strict', 'lax', 'none').default('strict'),
}).custom((environment: Record<string, unknown>, helpers) => {
  if (
    environment.NODE_ENV === 'production' &&
    [LOCAL_DEVELOPMENT_JWT_SECRET, TEST_JWT_SECRET].includes(environment.AUTH_JWT_SECRET as string)
  ) {
    return helpers.message({ custom: 'Production requires an explicit JWT secret.' });
  }

  if (environment.NODE_ENV === 'production' && environment.AUTH_REFRESH_COOKIE_SECURE !== true) {
    return helpers.message({ custom: 'Production requires a Secure refresh cookie.' });
  }

  if (environment.NODE_ENV === 'production' && Number(environment.TRUST_PROXY_HOPS) < 1) {
    return helpers.message({ custom: 'Production requires an explicit trusted proxy hop count.' });
  }

  if (
    environment.AUTH_REFRESH_COOKIE_SAME_SITE === 'none' &&
    environment.AUTH_REFRESH_COOKIE_SECURE !== true
  ) {
    return helpers.message({ custom: 'SameSite=None requires a Secure refresh cookie.' });
  }

  return environment;
});
