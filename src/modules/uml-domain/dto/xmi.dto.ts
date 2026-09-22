import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Min } from 'class-validator';
import { XMI_LIMITS } from '../xmi/xmi.constants';

const SHA256 = /^[a-f0-9]{64}$/u;

const normalizeHash = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLocaleLowerCase('en') : value;

export class XmiPreviewUploadDto {
  @ApiProperty({
    description: 'Archivo XMI UTF-8 limitado a 1 MiB.',
    format: 'binary',
    maxLength: XMI_LIMITS.maxBytes,
    type: 'string',
  })
  file!: unknown;
}

export class ApplyXmiImportDto {
  @ApiProperty({ minimum: 0, type: 'integer' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiProperty({ description: 'SHA-256 devuelto por el preview XMI.', pattern: SHA256.source })
  @Transform(normalizeHash)
  @IsString()
  @Matches(SHA256)
  sha256!: string;

  @ApiProperty({
    default: false,
    description:
      'Confirma aplicar solo el subconjunto válido cuando el preview declaró advertencias de pérdida.',
    required: false,
    type: 'boolean',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value === 'true' : value))
  @IsBoolean()
  @IsOptional()
  acknowledgeWarnings?: boolean;
}

export class ApplyXmiImportUploadDto extends ApplyXmiImportDto {
  @ApiProperty({
    description: 'El mismo archivo validado por preview.',
    format: 'binary',
    maxLength: XMI_LIMITS.maxBytes,
    type: 'string',
  })
  file!: unknown;
}

export class ExportXmiDto {
  @ApiProperty({ minimum: 0, type: 'integer' })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedRevision!: number;
}

export class XmiDiagnosticDto {
  @ApiProperty()
  code!: string;

  @ApiProperty()
  message!: string;

  @ApiProperty({ enum: ['warning'] })
  severity!: 'warning';

  @ApiProperty({ required: false })
  xmiId?: string;

  @ApiProperty({ required: false })
  xmiType?: string;
}

export class XmiProfileDto {
  @ApiProperty({ example: 'uml-class-designer-xmi' })
  id!: 'uml-class-designer-xmi';

  @ApiProperty({ example: '1.0.0' })
  version!: string;

  @ApiProperty({ nullable: true, type: String })
  xmiVersion!: string | null;

  @ApiProperty({ nullable: true, type: String })
  umlNamespace!: string | null;
}

export class XmiSummaryDto {
  @ApiProperty({ minimum: 0 })
  attributes!: number;

  @ApiProperty({ minimum: 0 })
  classes!: number;

  @ApiProperty({ minimum: 0 })
  interfaces!: number;

  @ApiProperty({ minimum: 0 })
  operations!: number;

  @ApiProperty({ minimum: 0 })
  relationships!: number;
}

export class XmiImportPreviewResponseDto {
  @ApiProperty({ type: XmiDiagnosticDto, isArray: true })
  diagnostics!: XmiDiagnosticDto[];

  @ApiProperty({ minimum: 0 })
  currentRevision!: number;

  @ApiProperty({ type: XmiProfileDto })
  profile!: XmiProfileDto;

  @ApiProperty({ pattern: SHA256.source })
  sha256!: string;

  @ApiProperty({ type: XmiSummaryDto })
  summary!: XmiSummaryDto;
}
