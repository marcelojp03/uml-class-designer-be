import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProjectRole } from '../../generated/prisma';
import { ACCESS_TOKEN_SECURITY_NAME } from '../auth/auth.constants';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { AddProjectMemberDto } from './dto/project.dto';
import { ProjectMemberResponseDto } from './dto/project-response.dto';
import { RequireProjectRoles } from './project-access.decorator';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectsService } from './projects.service';

@ApiTags('project-members')
@ApiBearerAuth(ACCESS_TOKEN_SECURITY_NAME)
@UseGuards(ProjectMemberGuard)
@RequireProjectRoles(ProjectRole.OWNER)
@Controller('projects/:projectId/members')
export class ProjectMembersController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista miembros como OWNER' })
  @ApiOkResponse({ type: ProjectMemberResponseDto, isArray: true })
  @ApiForbiddenResponse({ description: 'El miembro no es OWNER.' })
  list(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() owner: AuthenticatedPrincipal,
  ): Promise<ProjectMemberResponseDto[]> {
    return this.projectsService.listMembers(projectId, owner.id);
  }

  @Post()
  @ApiOperation({ summary: 'Agrega como EDITOR una cuenta confirmada por correo e ID' })
  @ApiCreatedResponse({ type: ProjectMemberResponseDto })
  @ApiConflictResponse({ description: 'El usuario ya es miembro.' })
  @ApiNotFoundResponse({ description: 'Proyecto o usuario registrado inexistente.' })
  add(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() owner: AuthenticatedPrincipal,
    @Body() input: AddProjectMemberDto,
  ): Promise<ProjectMemberResponseDto> {
    return this.projectsService.addEditor(projectId, owner.id, input);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':userId')
  @ApiOperation({ summary: 'Retira un EDITOR; el OWNER no puede eliminarse' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'El miembro objetivo es OWNER o el actor no es OWNER.' })
  @ApiNotFoundResponse({ description: 'Proyecto o miembro inexistente.' })
  remove(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('userId', new ParseUUIDPipe({ version: '4' })) userId: string,
    @CurrentUser() owner: AuthenticatedPrincipal,
  ): Promise<void> {
    return this.projectsService.removeEditor(projectId, owner.id, userId);
  }
}
