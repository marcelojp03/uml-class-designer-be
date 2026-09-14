import { ProjectRole } from '@prisma/client';
import { AccessTokenVerifierService } from '../auth/access-token-verifier.service';
import { PrismaService } from '../database/prisma.service';
import { ProjectCollaborationEventBus } from './project-collaboration-event-bus.service';
import { ProjectsService } from './projects.service';

describe('ProjectsService', () => {
  it('locks the project against document creation before snapshotting an editor removal', async () => {
    const transaction = {
      umlDocument: { findMany: jest.fn().mockResolvedValue([{ id: 'document-id' }]) },
      projectMember: { delete: jest.fn().mockResolvedValue({}) },
    };
    const prisma = {
      $transaction: jest.fn((operation: (client: typeof transaction) => Promise<unknown>) =>
        operation(transaction),
      ),
    } as unknown as PrismaService;
    const collaborationEvents = {
      publish: jest.fn(),
    } as unknown as ProjectCollaborationEventBus;
    const service = new ProjectsService(
      prisma,
      collaborationEvents,
      {} as AccessTokenVerifierService,
    );
    const internals = service as unknown as {
      lockMutationSession: (...args: unknown[]) => Promise<void>;
      lockProject: (...args: unknown[]) => Promise<boolean>;
      assertOwner: (...args: unknown[]) => Promise<void>;
      lockProjectMember: (...args: unknown[]) => Promise<{ role: ProjectRole } | null>;
    };
    jest.spyOn(internals, 'lockMutationSession').mockResolvedValue();
    const lockProject = jest.spyOn(internals, 'lockProject').mockResolvedValue(true);
    jest.spyOn(internals, 'assertOwner').mockResolvedValue();
    jest.spyOn(internals, 'lockProjectMember').mockResolvedValue({ role: ProjectRole.EDITOR });

    await service.removeEditor('project-id', 'owner-id', 'session-id', 'editor-id');

    expect(lockProject).toHaveBeenCalledWith(transaction, 'project-id', 'update');
    expect(collaborationEvents.publish).toHaveBeenCalledWith({
      type: 'member-removed',
      projectId: 'project-id',
      userId: 'editor-id',
      documentIds: ['document-id'],
    });
  });
});
