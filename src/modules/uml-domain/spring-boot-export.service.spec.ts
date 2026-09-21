import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { RequestTimeoutException } from '@nestjs/common';
import {
  SPRING_BOOT_EXPORT_LIMITS,
  SpringBootExportLimitError,
} from '../generation/spring-boot-export';
import { SpringBootExportService, throwSpringBootExportError } from './spring-boot-export.service';

function canonicalFixture(): Record<string, unknown> {
  return JSON.parse(
    readFileSync(resolve(process.cwd(), 'contracts/fixtures/valid-uml-model.json'), 'utf8'),
  ) as Record<string, unknown>;
}

describe('SpringBootExportService', () => {
  it('exports only the actor-scoped persisted snapshot without writing it', async () => {
    const model = canonicalFixture();
    const release = jest.fn();
    const findFirst = jest.fn().mockResolvedValue({
      id: 'document-id',
      projectId: 'project-id',
      canonicalModel: model,
      revision: 7,
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const canonicalValidator = {
      validateAndNormalize: jest.fn().mockReturnValue(model),
    };
    const quota = { acquire: jest.fn().mockReturnValue(release) };
    const service = new SpringBootExportService(
      { umlDocument: { findFirst } } as never,
      canonicalValidator as never,
      quota as never,
    );

    const exported = await service.exportDocument('project-id', 'document-id', 'actor-id', 7, {
      artifactId: 'safe-app',
      groupId: 'com.example',
      packageName: 'com.example.safe',
      applicationName: 'SafeApplication',
    });

    expect(exported.fileName).toBe('safe-app-spring-boot-r7.zip');
    expect(exported.bytes.subarray(0, 2).toString('utf8')).toBe('PK');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'document-id', projectId: 'project-id' }),
      }),
    );
    expect(canonicalValidator.validateAndNormalize).toHaveBeenCalledWith(
      model,
      7,
      expect.any(Date),
      { projectId: 'project-id', documentId: 'document-id' },
    );
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('returns the current revision before attempting generation when stale', async () => {
    const findFirst = jest.fn().mockResolvedValue({
      id: 'document-id',
      projectId: 'project-id',
      canonicalModel: canonicalFixture(),
      revision: 8,
      updatedAt: new Date('2026-09-20T00:00:00.000Z'),
    });
    const canonicalValidator = { validateAndNormalize: jest.fn() };
    const release = jest.fn();
    const service = new SpringBootExportService(
      { umlDocument: { findFirst } } as never,
      canonicalValidator as never,
      { acquire: jest.fn().mockReturnValue(release) } as never,
    );

    await expect(
      service.exportDocument('project-id', 'document-id', 'actor-id', 7, undefined),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        message: 'Document revision conflict.',
        currentRevision: 8,
      }),
    });
    expect(canonicalValidator.validateAndNormalize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized persisted UML arrays before canonical transformation', async () => {
    const model = canonicalFixture();
    const diagram = model.diagram as Record<string, unknown>;
    diagram.elements = Array.from({ length: SPRING_BOOT_EXPORT_LIMITS.maxClasses + 1 }, () => ({}));
    const canonicalValidator = { validateAndNormalize: jest.fn() };
    const release = jest.fn();
    const service = new SpringBootExportService(
      {
        umlDocument: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'document-id',
            projectId: 'project-id',
            canonicalModel: model,
            revision: 7,
            updatedAt: new Date('2026-09-20T00:00:00.000Z'),
          }),
        },
      } as never,
      canonicalValidator as never,
      { acquire: jest.fn().mockReturnValue(release) } as never,
    );

    await expect(
      service.exportDocument('project-id', 'document-id', 'actor-id', 7, undefined),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'CLASS_LIMIT_EXCEEDED' }),
    });
    expect(canonicalValidator.validateAndNormalize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized persisted UML relationships before canonical transformation', async () => {
    const model = canonicalFixture();
    const diagram = model.diagram as Record<string, unknown>;
    diagram.relationships = Array.from(
      { length: SPRING_BOOT_EXPORT_LIMITS.maxRelationships + 1 },
      () => ({}),
    );
    const canonicalValidator = { validateAndNormalize: jest.fn() };
    const release = jest.fn();
    const service = new SpringBootExportService(
      {
        umlDocument: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'document-id',
            projectId: 'project-id',
            canonicalModel: model,
            revision: 7,
            updatedAt: new Date('2026-09-20T00:00:00.000Z'),
          }),
        },
      } as never,
      canonicalValidator as never,
      { acquire: jest.fn().mockReturnValue(release) } as never,
    );

    await expect(
      service.exportDocument('project-id', 'document-id', 'actor-id', 7, undefined),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'RELATIONSHIP_LIMIT_EXCEEDED' }),
    });
    expect(canonicalValidator.validateAndNormalize).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('maps an archive timeout to the documented request timeout response', () => {
    let caught: unknown;
    try {
      throwSpringBootExportError(
        new SpringBootExportLimitError('ARCHIVE_TIMEOUT', 'Generated ZIP exceeded 10000 ms.'),
      );
    } catch (error: unknown) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutException);
    expect(caught).toMatchObject({
      response: expect.objectContaining({ code: 'ARCHIVE_TIMEOUT' }),
      status: 408,
    });
  });
});
