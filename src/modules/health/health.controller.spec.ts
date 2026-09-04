import { HealthController } from './health.controller';

describe('HealthController', () => {
  it('reports the service as healthy', () => {
    const response = new HealthController().check();

    expect(response.status).toBe('ok');
    expect(response.service).toBe('uml-class-designer-be');
    expect(Number.isNaN(Date.parse(response.timestamp))).toBe(false);
  });
});
