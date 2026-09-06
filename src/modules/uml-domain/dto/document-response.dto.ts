import { ApiProperty } from '@nestjs/swagger';

export class DocumentSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  projectId!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ example: '0.1.0' })
  schemaVersion!: string;

  @ApiProperty({ minimum: 0 })
  revision!: number;

  @ApiProperty({ format: 'uuid' })
  createdById!: string;

  @ApiProperty({ format: 'uuid' })
  updatedById!: string;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class DocumentResponseDto extends DocumentSummaryResponseDto {
  @ApiProperty({ allOf: [{ $ref: '#/components/schemas/CanonicalUmlModel' }] })
  canonicalModel!: Record<string, unknown>;
}

export class RevisionConflictResponseDto {
  @ApiProperty({ example: 'Document revision conflict.' })
  message!: string;

  @ApiProperty({ minimum: 0 })
  currentRevision!: number;
}

export class HttpConflictResponseDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({ example: 'A document with that name already exists in this project.' })
  message!: string;

  @ApiProperty({ example: 'Conflict' })
  error!: string;
}
