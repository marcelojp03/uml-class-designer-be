import * as Joi from 'joi';
import { isIP } from 'node:net';
import {
  LOCAL_DEVELOPMENT_JWT_SECRET,
  TEST_JWT_SECRET,
  normalizeNetworkAddress,
} from './app.config';

export const envValidationSchema = Joi.object({
  NODE_ENV: Joi.string().valid('development', 'test', 'production').required(),
  PORT: Joi.number().port().default(3000),
  HOST: Joi.string()
    .max(253)
    .pattern(/^[A-Za-z0-9.:-]+$/)
    .default('127.0.0.1'),
  TRUST_PROXY_HOPS: Joi.number().integer().min(0).max(1).default(0),
  TRUST_PROXY_ADDRESSES: Joi.string()
    .allow('')
    .custom((value: string, helpers) => {
      const addresses = value
        .split(',')
        .map((address) => normalizeNetworkAddress(address.trim()))
        .filter(Boolean);
      return addresses.every((address) => isIP(address) !== 0)
        ? value
        : helpers.error('any.invalid');
    })
    .default(''),
  CORS_ORIGINS: Joi.string()
    .custom((value: string, helpers) => {
      const origins = value.split(',').map((origin) => origin.trim());
      if (origins.length === 0 || origins.some((origin) => !origin || origin === '*')) {
        return helpers.error('any.invalid');
      }
      for (const origin of origins) {
        try {
          const parsed = new URL(origin);
          if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) {
            return helpers.error('any.invalid');
          }
        } catch {
          return helpers.error('any.invalid');
        }
      }
      return value;
    })
    .default('http://localhost:5173'),
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
  AUTH_SESSION_CLEANUP_INTERVAL_MS: Joi.number()
    .integer()
    .min(60_000)
    .max(86_400_000)
    .default(3_600_000),
  AUTH_SESSION_CLEANUP_BATCH_SIZE: Joi.number().integer().min(1).max(10_000).default(1000),
  COLLABORATION_SOCKET_MAX_PAYLOAD_BYTES: Joi.number()
    .integer()
    .min(1024)
    .max(1_048_576)
    .default(65_536),
  COLLABORATION_PING_TIMEOUT_MS: Joi.number().integer().min(5000).max(120_000).default(20_000),
  COLLABORATION_PING_INTERVAL_MS: Joi.number().integer().min(5000).max(120_000).default(25_000),
  COLLABORATION_COMMAND_LIMIT: Joi.number().integer().min(1).max(1000).default(30),
  COLLABORATION_COMMAND_WINDOW_MS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  COLLABORATION_CONTROL_EVENT_LIMIT: Joi.number().integer().min(1).max(5000).default(60),
  COLLABORATION_CONTROL_EVENT_WINDOW_MS: Joi.number()
    .integer()
    .min(1000)
    .max(60_000)
    .default(10_000),
  COLLABORATION_PRESENCE_MIN_INTERVAL_MS: Joi.number().integer().min(50).max(5000).default(100),
  COLLABORATION_LOCK_TTL_SECONDS: Joi.number().integer().min(5).max(120).default(30),
  COLLABORATION_MAX_PARTICIPANTS_PER_DOCUMENT: Joi.number().integer().min(1).max(500).default(100),
  COLLABORATION_MAX_DOCUMENTS_PER_SOCKET: Joi.number().integer().min(1).max(100).default(20),
  COLLABORATION_MAX_CONNECTED_SOCKETS: Joi.number().integer().min(10).max(100_000).default(1000),
  COLLABORATION_MAX_SOCKETS_PER_SESSION: Joi.number().integer().min(1).max(50).default(5),
  COLLABORATION_HANDSHAKE_LIMIT: Joi.number().integer().min(1).max(10_000).default(30),
  COLLABORATION_HANDSHAKE_GLOBAL_LIMIT: Joi.number().integer().min(1).max(100_000).default(200),
  COLLABORATION_HANDSHAKE_WINDOW_MS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  COLLABORATION_HANDSHAKE_TIMEOUT_MS: Joi.number().integer().min(1000).max(60_000).default(10_000),
  COLLABORATION_MAX_PENDING_HANDSHAKES: Joi.number().integer().min(1).max(1000).default(32),
  COLLABORATION_MAX_PENDING_MUTATIONS_PER_DOCUMENT: Joi.number()
    .integer()
    .min(8)
    .max(1000)
    .default(128),
  COLLABORATION_OPERATION_RECOVERY_INTERVAL_MS: Joi.number()
    .integer()
    .min(250)
    .max(60_000)
    .default(1000),
  COLLABORATION_OPERATION_RECOVERY_BATCH_SIZE: Joi.number().integer().min(1).max(500).default(100),
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
    Number(environment.TRUST_PROXY_HOPS) > 0 &&
    String(environment.TRUST_PROXY_ADDRESSES ?? '')
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean).length === 0
  ) {
    return helpers.message({ custom: 'Trusted proxy hops require explicit proxy addresses.' });
  }

  if (
    environment.AUTH_REFRESH_COOKIE_SAME_SITE === 'none' &&
    environment.AUTH_REFRESH_COOKIE_SECURE !== true
  ) {
    return helpers.message({ custom: 'SameSite=None requires a Secure refresh cookie.' });
  }

  return environment;
});
