import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import cookieParser = require('cookie-parser');
import helmet from 'helmet';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { AppModule } from './app.module';
import type { AppConfiguration } from './config/app.config';

const CANONICAL_SCHEMA_COMPONENT = 'CanonicalUmlModel';

function toOpenApiSchema(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(toOpenApiSchema);
  }
  if (value === null || typeof value !== 'object') {
    return value;
  }

  const converted: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (key === '$schema' || key === '$id' || key === '$defs') {
      continue;
    }
    if (key === 'const') {
      converted.enum = [nestedValue];
      continue;
    }
    if (key === 'exclusiveMinimum' && typeof nestedValue === 'number') {
      converted.minimum = nestedValue;
      converted.exclusiveMinimum = true;
      continue;
    }
    if (key === '$ref' && typeof nestedValue === 'string' && nestedValue.startsWith('#/$defs/')) {
      converted.$ref = `#/components/schemas/${CANONICAL_SCHEMA_COMPONENT}_${nestedValue.slice(8)}`;
      continue;
    }
    converted[key] = toOpenApiSchema(nestedValue);
  }
  if (
    converted.type === undefined &&
    Array.isArray(converted.enum) &&
    converted.enum.length > 0 &&
    converted.enum.every((item) => typeof item === 'string')
  ) {
    converted.type = 'string';
  }
  return converted;
}

function addCanonicalSchemaComponents(document: ReturnType<typeof SwaggerModule.createDocument>) {
  const source = JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/uml-model.schema.json'), 'utf8'),
  ) as Record<string, unknown>;
  const definitions = source.$defs as Record<string, unknown>;
  document.components ??= {};
  document.components.schemas ??= {};
  const schemas = document.components.schemas as Record<string, unknown>;
  schemas[CANONICAL_SCHEMA_COMPONENT] = toOpenApiSchema(source);
  for (const [name, schema] of Object.entries(definitions)) {
    schemas[`${CANONICAL_SCHEMA_COMPONENT}_${name}`] = toOpenApiSchema(schema);
  }
}

export async function createConfiguredApp() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bufferLogs: true,
    bodyParser: false,
  });
  const configService = app.get(ConfigService);
  const config = configService.getOrThrow<AppConfiguration>('app');

  app.getHttpAdapter().getInstance().disable('x-powered-by');
  if (config.trustProxyHops > 0) {
    app.set('trust proxy', config.trustProxyHops);
  }
  app.use(helmet());
  app.useBodyParser('json', { limit: '1mb' });
  app.use(cookieParser());
  app.enableCors({
    origin: config.corsOrigins,
    methods: ['GET', 'HEAD', 'OPTIONS', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Auth-Intent'],
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const swaggerConfig = new DocumentBuilder()
    .setTitle('UML Class Designer API')
    .setDescription('API interna de la herramienta CASE; no es el backend Spring Boot generado.')
    .setVersion('0.1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT' }, 'access-token')
    .addCookieAuth(
      config.auth.refreshCookieName,
      { type: 'apiKey', in: 'cookie' },
      'refresh-cookie',
    )
    .build();
  const openApiDocument = SwaggerModule.createDocument(app, swaggerConfig);
  addCanonicalSchemaComponents(openApiDocument);
  SwaggerModule.setup('docs', app, openApiDocument, {
    jsonDocumentUrl: 'docs/openapi.json',
  });

  return { app, config, openApiDocument };
}
