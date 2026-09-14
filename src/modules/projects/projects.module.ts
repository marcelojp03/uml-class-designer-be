import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectCollaborationEventBus } from './project-collaboration-event-bus.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  imports: [AuthModule],
  controllers: [ProjectsController, ProjectMembersController],
  providers: [ProjectsService, ProjectMemberGuard, ProjectCollaborationEventBus],
  exports: [ProjectMemberGuard, ProjectCollaborationEventBus],
})
export class ProjectsModule {}
