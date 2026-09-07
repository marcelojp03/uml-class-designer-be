import { SetMetadata } from '@nestjs/common';
import type { ProjectRole } from '@prisma/client';
import { PROJECT_ROLES_KEY } from './project-access.constants';

export const RequireProjectRoles = (...roles: ProjectRole[]) =>
  SetMetadata(PROJECT_ROLES_KEY, roles);
