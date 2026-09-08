import 'reflect-metadata';
import { createConfiguredApp } from './bootstrap';

async function bootstrap(): Promise<void> {
  const { app, config } = await createConfiguredApp();
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
}

void bootstrap();
