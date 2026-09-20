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
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiTooManyRequestsResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { ProjectRole } from '@prisma/client';
import type { Response } from 'express';
import { ACCESS_TOKEN_SECURITY_NAME } from '../auth/auth.constants';
import { CurrentUser } from '../auth/auth.decorators';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { RequireProjectRoles } from '../projects/project-access.decorator';
import { ProjectMemberGuard } from '../projects/project-member.guard';
import { CreateDocumentDto, UpdateDocumentDto } from './dto/document.dto';
import { ExportSpringBootDto } from './dto/spring-boot-export.dto';
import {
  DocumentResponseDto,
  DocumentSummaryResponseDto,
  HttpConflictResponseDto,
  RevisionConflictResponseDto,
} from './dto/document-response.dto';
import { DocumentsService } from './documents.service';
import { SpringBootExportService } from './spring-boot-export.service';

@ApiTags('uml-documents')
@ApiExtraModels(RevisionConflictResponseDto, HttpConflictResponseDto)
@ApiBearerAuth(ACCESS_TOKEN_SECURITY_NAME)
@UseGuards(ProjectMemberGuard)
@RequireProjectRoles(ProjectRole.OWNER, ProjectRole.EDITOR)
@Controller('projects/:projectId/documents')
export class DocumentsController {
  constructor(
    private readonly documentsService: DocumentsService,
    private readonly springBootExportService: SpringBootExportService,
  ) {}

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
    return this.documentsService.create(projectId, user.id, user.sessionId, input);
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

  @Post(':documentId/exports/spring-boot')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Exporta el snapshot UML persistido como ZIP Spring Boot determinista' })
  @ApiProduces('application/zip')
  @ApiOkResponse({
    description: 'ZIP Spring Boot generado desde el snapshot autorizado.',
    content: { 'application/zip': { schema: { type: 'string', format: 'binary' } } },
    headers: {
      'Cache-Control': { schema: { type: 'string', example: 'private, no-store' } },
      'Content-Disposition': { schema: { type: 'string' } },
      'Content-Length': { schema: { type: 'integer' } },
      'X-Content-Type-Options': { schema: { type: 'string', example: 'nosniff' } },
      'X-Document-Revision': { schema: { type: 'integer' } },
      'X-Generator-Version': { schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse({
    description: 'Snapshot persistido u opciones de exportacion invalidos.',
  })
  @ApiConflictResponse({
    description: 'La revision esperada no coincide con la revision persistida.',
    content: {
      'application/json': {
        schema: { $ref: getSchemaPath(RevisionConflictResponseDto) },
      },
    },
  })
  @ApiForbiddenResponse({ description: 'Un VIEWER no puede exportar.' })
  @ApiNotFoundResponse({
    description: 'Proyecto o documento inexistente, eliminado o inaccesible.',
  })
  @ApiTooManyRequestsResponse({
    description: 'Se alcanzo el limite local de frecuencia o concurrencia.',
  })
  async exportSpringBoot(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: ExportSpringBootDto,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.springBootExportService.exportDocument(
      projectId,
      documentId,
      user.id,
      input.expectedRevision,
      input.options,
    );
    response.setHeader('Content-Type', 'application/zip');
    response.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    response.setHeader('Content-Length', String(exported.bytes.byteLength));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Document-Revision', String(exported.documentRevision));
    response.setHeader('X-Generator-Version', exported.generatorVersion);
    response.status(HttpStatus.OK).send(exported.bytes);
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
    return this.documentsService.update(projectId, documentId, user.id, user.sessionId, input);
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
    return this.documentsService.delete(projectId, documentId, user.id, user.sessionId);
  }
}
