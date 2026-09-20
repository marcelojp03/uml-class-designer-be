import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ProjectRole } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';

const trimText = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

const normalizeEmail = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

const ASSIGNABLE_PROJECT_ROLES = [ProjectRole.EDITOR, ProjectRole.VIEWER] as const;

export class CreateProjectDto {
  @ApiProperty({ minLength: 1, maxLength: 160, example: 'Sistema de ventas' })
  @Transform(trimText)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @Transform(trimText)
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;
}

export class UpdateProjectDto {
  @ApiPropertyOptional({ minLength: 1, maxLength: 160 })
  @Transform(trimText)
  @ValidateIf((_, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ type: String, maxLength: 2000, nullable: true })
  @Transform(trimText)
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;
}

export class AddProjectMemberDto {
  @ApiProperty({ format: 'uuid', description: 'ID compartido por el usuario desde su perfil.' })
  @IsUUID('4')
  userId!: string;

  @ApiProperty({ format: 'email', example: 'editor@example.com' })
  @Transform(normalizeEmail)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @ApiPropertyOptional({
    enum: ASSIGNABLE_PROJECT_ROLES,
    default: ProjectRole.EDITOR,
    description: 'Solo se pueden asignar roles EDITOR o VIEWER; OWNER se crea con el proyecto.',
  })
  @IsOptional()
  @IsIn(ASSIGNABLE_PROJECT_ROLES)
  role?: (typeof ASSIGNABLE_PROJECT_ROLES)[number];
}
