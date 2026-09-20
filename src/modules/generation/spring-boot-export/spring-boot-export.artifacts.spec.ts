import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RelationalModel } from '../relational-model';
import { generateSpringBootProject } from '../spring-boot';
import { createDeterministicSpringBootArchive } from './spring-boot-export.archive';
import { generateSpringBootExportArtifacts } from './spring-boot-export.artifacts';
import { SpringBootExportArtifactError } from './spring-boot-export.types';

function fixture(name: string): RelationalModel {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), `contracts/fixtures/spring-boot/${name}`), 'utf8'),
  ) as RelationalModel;
}

describe('spring boot export artifacts', () => {
  it('creates deterministic static OpenAPI, Postman, and manifest artifacts', () => {
    const relationalModel = fixture('01-simple-crud.json');
    const project = generateSpringBootProject(relationalModel);
    const first = generateSpringBootExportArtifacts(relationalModel, {
      documentRevision: 4,
      project,
    });
    const second = generateSpringBootExportArtifacts(relationalModel, {
      documentRevision: 4,
      project,
    });

    expect(second).toEqual(first);
    expect(first.files.map((file) => file.path)).toEqual([
      'generation-manifest.json',
      'openapi/generated-api.openapi.json',
      'postman/generated-api.postman_collection.json',
    ]);

    const openApi = JSON.parse(first.openApi.content) as Record<string, any>;
    expect(openApi.openapi).toBe('3.1.0');
    expect(openApi.components.schemas.ApiError).toEqual({
      additionalProperties: false,
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        status: { maximum: 599, minimum: 100, type: 'integer' },
      },
      required: ['status', 'code', 'message'],
      type: 'object',
    });
    expect(openApi.paths['/api/customer'].post.responses['201']).toBeDefined();
    expect(openApi.paths['/api/customer/{id}'].delete.responses['204']).toBeDefined();

    const postman = JSON.parse(first.postmanCollection.content) as Record<string, any>;
    expect(postman.info.schema).toBe(
      'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    );
    expect(postman.variable).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'baseUrl', value: 'http://127.0.0.1:8080' }),
      ]),
    );
    expect(postman.item).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'Customer', item: expect.any(Array) }),
      ]),
    );
    const customerFolder = postman.item.find(
      (item: Record<string, any>) => item.name === 'Customer',
    ) as Record<string, any>;
    expect(customerFolder.item[0].request.url).toBe('{{baseUrl}}/api/customer');
    expect(customerFolder.item[0].event[0].script.exec).toEqual(
      expect.arrayContaining([expect.stringContaining('pm.execution.setNextRequest')]),
    );

    const manifest = JSON.parse(first.manifest.content) as Record<string, any>;
    expect(manifest.documentRevision).toBe(4);
    expect(manifest.sha256['pom.xml']).toBe(
      project.files.find((file) => file.path === 'pom.xml')?.sha256,
    );
    expect(manifest.sha256[first.openApi.path]).toBe(first.openApi.sha256);
    expect(manifest.sha256[first.postmanCollection.path]).toBe(first.postmanCollection.sha256);
  });

  it('keeps ZIP, OpenAPI, Postman, and manifest hashes identical across three generations', async () => {
    const hashes = await Promise.all(
      [1, 2, 3].map(async () => {
        const relationalModel = fixture('01-simple-crud.json');
        const project = generateSpringBootProject(relationalModel);
        const artifacts = generateSpringBootExportArtifacts(relationalModel, {
          documentRevision: 4,
          project,
        });
        const archive = await createDeterministicSpringBootArchive([
          ...project.files,
          ...artifacts.files,
        ]);
        return {
          manifest: sha256(artifacts.manifest.content),
          openApi: sha256(artifacts.openApi.content),
          postman: sha256(artifacts.postmanCollection.content),
          zip: sha256(archive),
        };
      }),
    );

    expect(hashes[1]).toEqual(hashes[0]);
    expect(hashes[2]).toEqual(hashes[0]);
  });

  it('rejects an invalid document revision before producing artifacts', () => {
    const relationalModel = fixture('01-simple-crud.json');
    expect(() =>
      generateSpringBootExportArtifacts(relationalModel, {
        documentRevision: -1,
        project: generateSpringBootProject(relationalModel),
      }),
    ).toThrow(SpringBootExportArtifactError);
  });
});

function sha256(value: Buffer | string): string {
  return createHash('sha256').update(value).digest('hex');
}
