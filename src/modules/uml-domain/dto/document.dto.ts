import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsInt, IsObject, IsString, MaxLength, Min, MinLength, ValidateIf } from 'class-validator';

const CANONICAL_MODEL_SCHEMA = '#/components/schemas/CanonicalUmlModel';

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class CreateDocumentDto {
  @ApiProperty({ minLength: 1, maxLength: 160, example: 'Modelo de dominio' })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiProperty({
    allOf: [{ $ref: CANONICAL_MODEL_SCHEMA }],
    description: 'Documento UML canónico validado contra el JSON Schema 0.1.0.',
  })
  @IsObject()
  canonicalModel!: Record<string, unknown>;
}

export class UpdateDocumentDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 160 })
  @Transform(trimText)
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiProperty({ minimum: 0, description: 'Revisión persistida que el cliente leyó.' })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({
    allOf: [{ $ref: CANONICAL_MODEL_SCHEMA }],
    description: 'Documento UML canónico completo, nunca un snapshot de React Flow.',
  })
  @IsObject()
  canonicalModel!: Record<string, unknown>;
}
