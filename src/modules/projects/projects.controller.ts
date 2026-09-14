import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { ProjectRole } from '@prisma/client';
import { ACCESS_TOKEN_SECURITY_NAME } from '../auth/auth.constants';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import { ProjectResponseDto } from './dto/project-response.dto';
import { RequireProjectRoles } from './project-access.decorator';
import { ProjectMemberGuard } from './project-member.guard';
import { ProjectsService } from './projects.service';

@ApiTags('projects')
@ApiBearerAuth(ACCESS_TOKEN_SECURITY_NAME)
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista únicamente los proyectos del usuario' })
  @ApiOkResponse({ type: ProjectResponseDto, isArray: true })
  list(@CurrentUser() user: AuthenticatedPrincipal): Promise<ProjectResponseDto[]> {
    return this.projectsService.listForUser(user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Crea un proyecto y su única membresía OWNER atómicamente' })
  @ApiCreatedResponse({ type: ProjectResponseDto })
  create(
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: CreateProjectDto,
  ): Promise<ProjectResponseDto> {
    return this.projectsService.create(user.id, user.sessionId, input);
  }

  @UseGuards(ProjectMemberGuard)
  @Get(':projectId')
  @ApiOperation({ summary: 'Consulta un proyecto donde el usuario es miembro' })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiNotFoundResponse({ description: 'Proyecto inexistente o fuera del alcance del usuario.' })
  get(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<ProjectResponseDto> {
    return this.projectsService.getForUser(projectId, user.id);
  }

  @UseGuards(ProjectMemberGuard)
  @RequireProjectRoles(ProjectRole.OWNER)
  @Patch(':projectId')
  @ApiOperation({ summary: 'Actualiza un proyecto como OWNER' })
  @ApiOkResponse({ type: ProjectResponseDto })
  @ApiForbiddenResponse({ description: 'El miembro no es OWNER.' })
  @ApiNotFoundResponse({ description: 'Proyecto inexistente o fuera del alcance del usuario.' })
  update(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    return this.projectsService.updateOwnerProject(projectId, user.id, user.sessionId, input);
  }

  @UseGuards(ProjectMemberGuard)
  @RequireProjectRoles(ProjectRole.OWNER)
  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':projectId')
  @ApiOperation({ summary: 'Elimina un proyecto y sus dependencias como OWNER' })
  @ApiNoContentResponse()
  @ApiForbiddenResponse({ description: 'El miembro no es OWNER.' })
  @ApiNotFoundResponse({ description: 'Proyecto inexistente o fuera del alcance del usuario.' })
  delete(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<void> {
    return this.projectsService.deleteOwnerProject(projectId, user.id, user.sessionId);
  }
}
