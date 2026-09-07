import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isUUID } from 'class-validator';
import type { Request } from 'express';
import type { ProjectRole } from '@prisma/client';
import type { AuthenticatedPrincipal } from '../auth/auth.types';
import { PrismaService } from '../database/prisma.service';
import { PROJECT_ROLES_KEY } from './project-access.constants';

type ProjectRequest = Request & {
  user?: AuthenticatedPrincipal;
  projectMembership?: { role: ProjectRole };
};

@Injectable()
export class ProjectMemberGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<ProjectRequest>();
    const rawProjectId = request.params.projectId;
    const projectId = Array.isArray(rawProjectId) ? undefined : rawProjectId;
    if (!projectId || !isUUID(projectId, '4')) {
      throw new BadRequestException('projectId must be a UUID.');
    }
    if (!request.user) {
      throw new Error('Authenticated principal is missing after the access guard.');
    }

    const membership = await this.prisma.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId: request.user.id } },
      select: { role: true },
    });
    if (!membership) {
      throw new NotFoundException('Project not found.');
    }

    const acceptedRoles = this.reflector.getAllAndOverride<ProjectRole[]>(PROJECT_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (acceptedRoles && !acceptedRoles.includes(membership.role)) {
      throw new ForbiddenException('Insufficient project permissions.');
    }

    request.projectMembership = membership;
    return true;
  }
}
