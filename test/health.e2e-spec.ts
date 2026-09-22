import type { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { createConfiguredApp } from '../src/bootstrap';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication;
  const allowedOrigin = 'http://localhost:5173';

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    const configured = await createConfiguredApp();
    app = configured.app;
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health', async () => {
    const response = await request(app.getHttpServer()).get('/health').expect(200);

    expect(response.body).toMatchObject({
      status: 'ok',
      service: 'uml-class-designer-be',
    });
    expect(Number.isNaN(Date.parse(response.body.timestamp as string))).toBe(false);
  });

  it('expone los metadatos de exportación a un navegador autorizado', async () => {
    const preflight = await request(app.getHttpServer())
      .options(
        '/projects/00000000-0000-4000-8000-000000000000/documents/00000000-0000-4000-8000-000000000000/exports/spring-boot',
      )
      .set('Origin', allowedOrigin)
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'Authorization, Content-Type')
      .expect(204);

    expect(preflight.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(preflight.headers['access-control-allow-credentials']).toBe('true');

    const response = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', allowedOrigin)
      .expect(200);
    const exposedHeaders = String(response.headers['access-control-expose-headers'] ?? '')
      .split(',')
      .map((header) => header.trim().toLowerCase())
      .filter(Boolean);

    expect(response.headers['access-control-allow-origin']).toBe(allowedOrigin);
    expect(response.headers['access-control-allow-credentials']).toBe('true');
    expect(exposedHeaders).toEqual([
      'content-disposition',
      'content-length',
      'x-document-revision',
      'x-generator-version',
      'x-xmi-profile-version',
      'x-xmi-sha256',
    ]);
    expect(exposedHeaders).not.toContain('*');
  });
});
