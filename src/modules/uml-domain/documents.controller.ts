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
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ProjectRole } from '../../generated/prisma';
import { ACCESS_TOKEN_SECURITY_NAME } from '../auth/auth.constants';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { RequireProjectRoles } from '../projects/project-access.decorator';
import { ProjectMemberGuard } from '../projects/project-member.guard';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto';
import {
  DocumentResponseDto,
  DocumentSummaryResponseDto,
  HttpConflictResponseDto,
  RevisionConflictResponseDto,
} from './dto/document-response.dto';
import { DocumentsService } from './documents.service';

@ApiTags('uml-documents')
@ApiExtraModels(RevisionConflictResponseDto, HttpConflictResponseDto)
@ApiBearerAuth(ACCESS_TOKEN_SECURITY_NAME)
@UseGuards(ProjectMemberGuard)
@RequireProjectRoles(ProjectRole.OWNER, ProjectRole.EDITOR)
@Controller('projects/:projectId/documents')
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista documentos del proyecto para OWNER o EDITOR' })
  @ApiOkResponse({ type: DocumentSummaryResponseDto, isArray: true })
  list(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<DocumentSummaryResponseDto[]> {
    return this.documentsService.list(projectId, user.id);
  }

  @Post()
  @ApiOperation({ summary: 'Crea y valida un documento UML canónico' })
  @ApiCreatedResponse({ type: DocumentResponseDto })
  @ApiBadRequestResponse({ description: 'El canonicalModel no cumple el schema 0.1.0.' })
  @ApiConflictResponse({ description: 'El nombre ya existe dentro del proyecto.' })
  create(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: CreateDocumentDto,
  ): Promise<DocumentResponseDto> {
    return this.documentsService.create(projectId, user.id, input);
  }

  @Get(':documentId')
  @ApiOperation({ summary: 'Consulta el modelo canónico dentro del proyecto autorizado' })
  @ApiOkResponse({ type: DocumentResponseDto })
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  get(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<DocumentResponseDto> {
    return this.documentsService.get(projectId, documentId, user.id);
  }

  @Put(':documentId')
  @ApiOperation({ summary: 'Actualiza por compare-and-swap e incrementa la revisión una vez' })
  @ApiOkResponse({ type: DocumentResponseDto })
  @ApiBadRequestResponse({ description: 'DTO o canonicalModel inválidos.' })
  @ApiConflictResponse({
    description: 'Conflicto de revisión o de nombre único.',
    schema: {
      oneOf: [
        { $ref: getSchemaPath(RevisionConflictResponseDto) },
        { $ref: getSchemaPath(HttpConflictResponseDto) },
      ],
    },
  })
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  update(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: UpdateDocumentDto,
  ): Promise<DocumentResponseDto> {
    return this.documentsService.update(projectId, documentId, user.id, input);
  }

  @HttpCode(HttpStatus.NO_CONTENT)
  @Delete(':documentId')
  @ApiOperation({ summary: 'Elimina un documento como OWNER o EDITOR; revisiones caen en cascada' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  delete(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
  ): Promise<void> {
    return this.documentsService.delete(projectId, documentId, user.id);
  }
}
