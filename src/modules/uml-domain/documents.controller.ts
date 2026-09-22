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
  Query,
  Put,
  Res,
  UseGuards,
  UseInterceptors,
  UploadedFile,
} from '@nestjs/common';
import {
  ApiBody,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiConsumes,
  ApiExtraModels,
  ApiForbiddenResponse,
  ApiInternalServerErrorResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiPayloadTooLargeResponse,
  ApiProduces,
  ApiRequestTimeoutResponse,
  ApiTags,
  ApiTooManyRequestsResponse,
  ApiUnauthorizedResponse,
  ApiUnsupportedMediaTypeResponse,
  getSchemaPath,
} from '@nestjs/swagger';
import { FileInterceptor } from '@nestjs/platform-express';
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
  ApplyXmiImportDto,
  ApplyXmiImportUploadDto,
  ExportXmiDto,
  XmiImportPreviewResponseDto,
  XmiPreviewUploadDto,
} from './dto/xmi.dto';
import {
  DocumentResponseDto,
  DocumentSummaryResponseDto,
  HttpConflictResponseDto,
  RevisionConflictResponseDto,
} from './dto/document-response.dto';
import { DocumentsService } from './documents.service';
import { SpringBootExportService } from './spring-boot-export.service';
import { XMI_CONTENT_TYPE, XMI_LIMITS } from './xmi/xmi.constants';
import {
  XmiInteroperabilityService,
  type UploadedXmiFile,
} from './xmi/xmi-interoperability.service';

const XMI_UPLOAD_LIMITS = {
  fieldSize: 128,
  fields: 3,
  fileSize: XMI_LIMITS.maxBytes,
  files: 1,
  // Busboy emits the parts limit event when it reaches the configured count.
  // Allow the three bounded fields plus one file, while fields/files stay bounded.
  parts: 5,
};

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
    private readonly xmiInteroperabilityService: XmiInteroperabilityService,
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

  @Post(':documentId/xmi/import/preview')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: XMI_UPLOAD_LIMITS }))
  @ApiOperation({ summary: 'Previsualiza un XMI sin persistir cambios' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: XmiPreviewUploadDto })
  @ApiOkResponse({ type: XmiImportPreviewResponseDto })
  @ApiBadRequestResponse({ description: 'XMI malformado, inválido o semánticamente incompatible.' })
  @ApiUnauthorizedResponse({ description: 'Access token o sesión inválidos.' })
  @ApiForbiddenResponse({ description: 'El actor no tiene permiso para importar el documento.' })
  @ApiRequestTimeoutResponse({
    description: 'El procesamiento XMI excedió el presupuesto permitido.',
  })
  @ApiPayloadTooLargeResponse({ description: 'El archivo XMI supera los límites permitidos.' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'El archivo no declara un tipo XML/XMI aceptado.',
  })
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  async previewXmiImport(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @UploadedFile() file: UploadedXmiFile | undefined,
  ): Promise<XmiImportPreviewResponseDto> {
    return this.xmiInteroperabilityService.preview(projectId, documentId, user, file);
  }

  @Post(':documentId/xmi/import/apply')
  @HttpCode(HttpStatus.OK)
  @UseInterceptors(FileInterceptor('file', { limits: XMI_UPLOAD_LIMITS }))
  @ApiOperation({ summary: 'Aplica un XMI validado mediante compare-and-swap' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({ type: ApplyXmiImportUploadDto })
  @ApiOkResponse({ type: DocumentResponseDto })
  @ApiBadRequestResponse({
    description:
      'XMI, hash o modelo canónico inválido, o advertencias del preview sin confirmar (acknowledgeWarnings).',
  })
  @ApiUnauthorizedResponse({ description: 'Access token o sesión inválidos.' })
  @ApiForbiddenResponse({ description: 'El actor no tiene permiso para importar el documento.' })
  @ApiRequestTimeoutResponse({
    description: 'El procesamiento XMI excedió el presupuesto permitido.',
  })
  @ApiConflictResponse({
    description: 'Conflicto de revisión, nombre o lock activo.',
    content: {
      'application/json': { schema: { $ref: getSchemaPath(RevisionConflictResponseDto) } },
    },
  })
  @ApiPayloadTooLargeResponse({ description: 'El archivo XMI supera los límites permitidos.' })
  @ApiUnsupportedMediaTypeResponse({
    description: 'El archivo no declara un tipo XML/XMI aceptado.',
  })
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  async applyXmiImport(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Body() input: ApplyXmiImportDto,
    @UploadedFile() file: UploadedXmiFile | undefined,
  ): Promise<DocumentResponseDto> {
    return this.xmiInteroperabilityService.apply(
      projectId,
      documentId,
      user,
      input.expectedRevision,
      input.sha256,
      input.acknowledgeWarnings === true,
      file,
    );
  }

  @Get(':documentId/xmi/export')
  @ApiOperation({ summary: 'Exporta el snapshot UML persistido como XMI UTF-8' })
  @ApiProduces(XMI_CONTENT_TYPE)
  @ApiOkResponse({
    content: { [XMI_CONTENT_TYPE]: { schema: { format: 'binary', type: 'string' } } },
    description: 'XMI generado desde el snapshot autorizado y validado.',
    headers: {
      'Cache-Control': { schema: { example: 'private, no-store', type: 'string' } },
      'Content-Disposition': { schema: { type: 'string' } },
      'Content-Length': { schema: { type: 'integer' } },
      'X-Content-Type-Options': { schema: { example: 'nosniff', type: 'string' } },
      'X-Document-Revision': { schema: { type: 'integer' } },
      'X-XMI-Profile-Version': { schema: { type: 'string' } },
      'X-XMI-SHA256': { schema: { type: 'string' } },
    },
  })
  @ApiBadRequestResponse({ description: 'Revisión solicitada o snapshot persistido inválido.' })
  @ApiUnauthorizedResponse({ description: 'Access token o sesión inválidos.' })
  @ApiForbiddenResponse({ description: 'El actor no tiene permiso para exportar el documento.' })
  @ApiConflictResponse({
    description: 'La revisión esperada no coincide con la revisión persistida.',
    content: {
      'application/json': { schema: { $ref: getSchemaPath(RevisionConflictResponseDto) } },
    },
  })
  @ApiNotFoundResponse({ description: 'Documento inexistente o perteneciente a otro proyecto.' })
  async exportXmi(
    @Param('projectId', new ParseUUIDPipe({ version: '4' })) projectId: string,
    @Param('documentId', new ParseUUIDPipe({ version: '4' })) documentId: string,
    @CurrentUser() user: AuthenticatedPrincipal,
    @Query() input: ExportXmiDto,
    @Res() response: Response,
  ): Promise<void> {
    const exported = await this.xmiInteroperabilityService.exportDocument(
      projectId,
      documentId,
      user,
      input.expectedRevision,
    );
    response.setHeader('Content-Type', XMI_CONTENT_TYPE);
    response.setHeader('Content-Disposition', `attachment; filename="${exported.fileName}"`);
    response.setHeader('Content-Length', String(exported.bytes.byteLength));
    response.setHeader('Cache-Control', 'private, no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Document-Revision', String(exported.documentRevision));
    response.setHeader('X-XMI-Profile-Version', exported.profileVersion);
    response.setHeader('X-XMI-SHA256', exported.sha256);
    response.status(HttpStatus.OK).send(exported.bytes);
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
  @ApiUnauthorizedResponse({ description: 'Access token o sesión inválidos.' })
  @ApiForbiddenResponse({ description: 'El actor no tiene permiso para exportar el documento.' })
  @ApiConflictResponse({
    description: 'La revision esperada no coincide con la revision persistida.',
    content: {
      'application/json': {
        schema: { $ref: getSchemaPath(RevisionConflictResponseDto) },
      },
    },
  })
  @ApiNotFoundResponse({
    description: 'Proyecto o documento inexistente, eliminado o inaccesible.',
  })
  @ApiTooManyRequestsResponse({
    description: 'Se alcanzo el limite local de frecuencia o concurrencia.',
  })
  @ApiRequestTimeoutResponse({ description: 'La generación Spring Boot excedió el tiempo máximo.' })
  @ApiInternalServerErrorResponse({ description: 'No fue posible generar el ZIP solicitado.' })
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
