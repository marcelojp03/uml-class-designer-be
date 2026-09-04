import 'reflect-metadata';
import { createConfiguredApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const { app, config } = await createConfiguredApp();
  await app.listen(config.port, '127.0.0.1');
}

void bootstrap();
