import { registerAs } from '@nestjs/config';

export interface AppConfiguration {
  port: number;
  corsOrigins: string[];
}

export default registerAs(
  'app',
  (): AppConfiguration => ({
    port: Number(process.env.PORT ?? 3000),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
  }),
);
