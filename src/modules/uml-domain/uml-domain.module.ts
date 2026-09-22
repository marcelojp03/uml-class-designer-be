import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectsModule } from '../projects/projects.module';
import { CanonicalModelValidator } from './canonical-model.validator';
import { CollaborationContractValidator } from './collaboration-contract.validator';
import { CollaborationGateway } from './collaboration.gateway';
import { CollaborationLockStore } from './collaboration-lock.store';
import { CollaborationPresenceStore } from './collaboration-presence.store';
import { CollaborationRateLimiterService } from './collaboration-rate-limiter.service';
import { DocumentCommandService } from './document-command.service';
import { DocumentCollaborationEventBus } from './document-collaboration-event-bus.service';
import { DocumentMutationQueueService } from './document-mutation-queue.service';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SpringBootExportQuotaService } from './spring-boot-export-quota.service';
import { SpringBootExportService } from './spring-boot-export.service';
import { UmlCommandExecutor } from './uml-command.executor';
import { XmiInteroperabilityService } from './xmi/xmi-interoperability.service';

@Module({
  imports: [AuthModule, ProjectsModule],
  controllers: [DocumentsController],
  providers: [
    CanonicalModelValidator,
    DocumentsService,
    CollaborationContractValidator,
    UmlCommandExecutor,
    DocumentMutationQueueService,
    DocumentCollaborationEventBus,
    CollaborationLockStore,
    CollaborationPresenceStore,
    CollaborationRateLimiterService,
    DocumentCommandService,
    CollaborationGateway,
    SpringBootExportQuotaService,
    SpringBootExportService,
    XmiInteroperabilityService,
  ],
})
export class UmlDomainModule {}
