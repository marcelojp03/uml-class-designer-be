import { Module } from '@nestjs/common';
import { ProjectMembersController } from './project-members.controller';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController, ProjectMembersController],
  providers: [ProjectsService, ProjectMemberGuard],
  exports: [ProjectMemberGuard],
})
export class ProjectsModule {}
