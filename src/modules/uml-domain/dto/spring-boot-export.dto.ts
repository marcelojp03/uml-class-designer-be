import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';

const JAVA_PACKAGE = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)*$/;
const MAVEN_ARTIFACT = /^[a-z][a-z0-9.-]{0,99}$/;
const JAVA_APPLICATION = /^[A-Z][A-Za-z0-9_$]*$/;

export class SpringBootExportOptionsDto {
  @ApiPropertyOptional({ example: 'com.example', maxLength: 160, pattern: JAVA_PACKAGE.source })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(JAVA_PACKAGE)
  groupId?: string;

  @ApiPropertyOptional({ example: 'generated-app', maxLength: 100, pattern: MAVEN_ARTIFACT.source })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(MAVEN_ARTIFACT)
  artifactId?: string;

  @ApiPropertyOptional({
    example: 'com.example.generated',
    maxLength: 160,
    pattern: JAVA_PACKAGE.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(JAVA_PACKAGE)
  packageName?: string;

  @ApiPropertyOptional({
    example: 'GeneratedApplication',
    maxLength: 160,
    pattern: JAVA_APPLICATION.source,
  })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(JAVA_APPLICATION)
  applicationName?: string;
}

export class ExportSpringBootDto {
  @ApiProperty({ type: 'integer', format: 'int32', minimum: 0, example: 7 })
  @IsInt()
  @Min(0)
  expectedRevision!: number;

  @ApiPropertyOptional({ type: SpringBootExportOptionsDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => SpringBootExportOptionsDto)
  options?: SpringBootExportOptionsDto;
}
