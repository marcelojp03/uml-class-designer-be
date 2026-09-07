import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, ProjectRole } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import type { AddProjectMemberDto, CreateProjectDto, UpdateProjectDto } from './dto/project.dto';
import type { ProjectMemberResponseDto, ProjectResponseDto } from './dto/project-response.dto';

@Injectable()
export class ProjectsService {
  constructor(private readonly prisma: PrismaService) {}

  async listForUser(userId: string): Promise<ProjectResponseDto[]> {
    const projects = await this.prisma.project.findMany({
      where: { members: { some: { userId } } },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        members: { where: { userId }, select: { role: true }, take: 1 },
      },
      orderBy: { updatedAt: 'desc' },
    });

    return projects.map((project) => {
      const membership = project.members[0];
      if (!membership) {
        throw new Error('Project membership invariant violated.');
      }
      return {
        id: project.id,
        name: project.name,
        description: project.description,
        role: membership.role,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
      };
    });
  }

  async create(userId: string, input: CreateProjectDto): Promise<ProjectResponseDto> {
    const project = await this.prisma.$transaction((transaction) =>
      transaction.project.create({
        data: {
          name: input.name,
          description: this.optionalDescription(input.description),
          ownerId: userId,
          members: { create: { userId, role: ProjectRole.OWNER } },
        },
        select: { id: true, name: true, description: true, createdAt: true, updatedAt: true },
      }),
    );

    return { ...project, role: ProjectRole.OWNER };
  }

  async getForUser(projectId: string, userId: string): Promise<ProjectResponseDto> {
    const project = await this.prisma.project.findFirst({
      where: { id: projectId, members: { some: { userId } } },
      select: {
        id: true,
        name: true,
        description: true,
        createdAt: true,
        updatedAt: true,
        members: { where: { userId }, select: { role: true }, take: 1 },
      },
    });
    if (!project || !project.members[0]) {
      throw new NotFoundException('Project not found.');
    }

    return {
      id: project.id,
      name: project.name,
      description: project.description,
      role: project.members[0].role,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
    };
  }

  async updateOwnerProject(
    projectId: string,
    userId: string,
    input: UpdateProjectDto,
  ): Promise<ProjectResponseDto> {
    if (input.name === undefined && input.description === undefined) {
      throw new BadRequestException('At least one project field must be provided.');
    }

    const updated = await this.prisma.project.updateMany({
      where: {
        id: projectId,
        members: { some: { userId, role: ProjectRole.OWNER } },
      },
      data: {
        ...(input.name === undefined ? {} : { name: input.name }),
        ...(input.description === undefined
          ? {}
          : { description: this.optionalDescription(input.description) }),
      },
    });
    if (updated.count !== 1) {
      throw new NotFoundException('Project not found.');
    }
    return this.getForUser(projectId, userId);
  }

  async deleteOwnerProject(projectId: string, userId: string): Promise<void> {
    const deleted = await this.prisma.$transaction((transaction) =>
      transaction.project.deleteMany({
        where: {
          id: projectId,
          members: { some: { userId, role: ProjectRole.OWNER } },
        },
      }),
    );
    if (deleted.count !== 1) {
      throw new NotFoundException('Project not found.');
    }
  }

  async listMembers(projectId: string, ownerId: string): Promise<ProjectMemberResponseDto[]> {
    await this.assertOwner(projectId, ownerId);
    const members = await this.prisma.projectMember.findMany({
      where: { projectId },
      select: {
        userId: true,
        role: true,
        createdAt: true,
        user: { select: { email: true, displayName: true } },
      },
      orderBy: [{ role: 'desc' }, { createdAt: 'asc' }],
    });
    return members.map((member) => ({
      userId: member.userId,
      email: member.user.email,
      displayName: member.user.displayName,
      role: member.role,
      createdAt: member.createdAt,
    }));
  }

  async addEditor(
    projectId: string,
    ownerId: string,
    input: AddProjectMemberDto,
  ): Promise<ProjectMemberResponseDto> {
    try {
      const member = await this.prisma.$transaction(async (transaction) => {
        await this.assertOwner(projectId, ownerId, transaction);
        const user = await transaction.user.findFirst({
          where: { id: input.userId, email: input.email.trim().toLowerCase() },
          select: { id: true, email: true, displayName: true },
        });
        if (!user) {
          throw new NotFoundException('Registered user not found.');
        }

        const created = await transaction.projectMember.create({
          data: { projectId, userId: user.id, role: ProjectRole.EDITOR },
          select: { userId: true, role: true, createdAt: true },
        });
        return { ...created, user };
      });

      return {
        userId: member.userId,
        email: member.user.email,
        displayName: member.user.displayName,
        role: member.role,
        createdAt: member.createdAt,
      };
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('User is already a project member.');
      }
      throw error;
    }
  }

  async removeEditor(projectId: string, ownerId: string, userId: string): Promise<void> {
    await this.prisma.$transaction(async (transaction) => {
      await this.assertOwner(projectId, ownerId, transaction);
      const member = await transaction.projectMember.findUnique({
        where: { projectId_userId: { projectId, userId } },
        select: { role: true },
      });
      if (!member) {
        throw new NotFoundException('Project member not found.');
      }
      if (member.role === ProjectRole.OWNER) {
        throw new ForbiddenException('The project owner cannot be removed.');
      }
      await transaction.projectMember.delete({
        where: { projectId_userId: { projectId, userId } },
      });
    });
  }

  private async assertOwner(
    projectId: string,
    userId: string,
    client: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const membership = await client.projectMember.findUnique({
      where: { projectId_userId: { projectId, userId } },
      select: { role: true },
    });
    if (!membership) {
      throw new NotFoundException('Project not found.');
    }
    if (membership.role !== ProjectRole.OWNER) {
      throw new ForbiddenException('Insufficient project permissions.');
    }
  }

  private optionalDescription(description: string | null | undefined): string | null {
    return description?.trim() || null;
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
  }
}
