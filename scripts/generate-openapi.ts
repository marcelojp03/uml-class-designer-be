import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createConfiguredApp } from '../src/bootstrap';

const outputPath = resolve(process.cwd(), 'contracts/openapi.json');
const checkOnly = process.argv.includes('--check');

async function run(): Promise<void> {
  process.env.NODE_ENV ??= 'test';
  const { app, openApiDocument } = await createConfiguredApp();

  try {
    const generated = `${JSON.stringify(openApiDocument, null, 2)}\n`;
    if (checkOnly) {
      const existing = await readFile(outputPath, 'utf8').catch(() => '');
      if (existing !== generated) {
        throw new Error('contracts/openapi.json no está sincronizado. Ejecuta pnpm openapi:generate.');
      }
      console.log('OpenAPI sincronizado: contracts/openapi.json');
      return;
    }

    await writeFile(outputPath, generated, 'utf8');
    console.log('OpenAPI generado: contracts/openapi.json');
  } finally {
    await app.close();
  }
}

run().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
