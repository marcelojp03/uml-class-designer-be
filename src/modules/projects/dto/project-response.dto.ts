import { ApiProperty } from '@nestjs/swagger';
import { ProjectRole } from '../../../generated/prisma';

export class ProjectResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ type: String, nullable: true })
  description!: string | null;

  @ApiProperty({ enum: ProjectRole })
  role!: ProjectRole;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class ProjectMemberResponseDto {
  @ApiProperty({ format: 'uuid' })
  userId!: string;

  @ApiProperty({ format: 'email' })
  email!: string;

  @ApiProperty()
  displayName!: string;

  @ApiProperty({ enum: ProjectRole })
  role!: ProjectRole;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;
}
