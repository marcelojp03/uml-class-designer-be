import type { INestApplication } from '@nestjs/common';
import request = require('supertest');
import { createConfiguredApp } from '../src/bootstrap';

describe('Health endpoint (e2e)', () => {
  let app: INestApplication;

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
});
