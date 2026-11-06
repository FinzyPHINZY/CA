import { AdminAuditLog, User, UserRoleEntity } from '@app/common';
import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ListAuditLogsQueryDto } from './dto/list-audit-logs-query.dto';
import { CreateUserRoleDto } from './dto/create-user-role.dto';
import { UpdateUserRoleDto } from './dto/update-user-role.dto';
import {
  ADMIN_AUDIT_LOG_ALIAS,
  ADMIN_USER_ROLE_ENTITY_ALIAS,
} from './admin-query-aliases';

type RequestContext = { ipAddress?: string; userAgent?: string };

@Injectable()
export class AdminUserRolesService {
  constructor(private readonly dataSource: DataSource) {}

  async createRole(
    dto: CreateUserRoleDto,
    actorUserId: string,
    context?: RequestContext,
  ) {
    const repo = this.dataSource.getRepository(UserRoleEntity);
    const code = dto.code.trim().toLowerCase();

    const existing = await repo.findOne({ where: { code } });
    if (existing) {
      throw new BadRequestException(`Role code "${code}" already exists`);
    }

    const role = repo.create({
      code,
      name: dto.name.trim(),
      isSystem: dto.isSystem ?? false,
    });
    const saved = await repo.save(role);

    await this.logAudit({
      actorUserId,
      action: 'admin.role.created',
      resourceType: 'user_role',
      resourceId: saved.id,
      summary: `Created role ${saved.name} (${saved.code})`,
      metadata: {
        entity: 'user_role',
        template: 'role_created',
        role: { id: saved.id, code: saved.code, name: saved.name },
      },
      ...context,
    });

    return saved;
  }

  async listRoles(adminOnly = false) {
    return this.listRolesWithAudit(adminOnly);
  }

  async listRolesWithAudit(
    adminOnly: boolean,
    actorUserId?: string,
    context?: RequestContext,
  ) {
    const repo = this.dataSource.getRepository(UserRoleEntity);
    const urole = ADMIN_USER_ROLE_ENTITY_ALIAS;
    const qb = repo.createQueryBuilder(urole).orderBy(`${urole}.code`, 'ASC');
    if (adminOnly) {
      qb.where(`${urole}.code LIKE :pattern`, { pattern: '%admin%' });
    }
    const roles = await qb.getMany();

    if (actorUserId) {
      await this.logAudit({
        actorUserId,
        action: 'admin.role.listed',
        resourceType: 'user_role',
        summary: adminOnly ? 'Listed admin roles' : 'Listed all user roles',
        metadata: {
          entity: 'user_role',
          template: 'role_listed',
          adminOnly,
          count: roles.length,
        },
        ...context,
      });
    }

    return roles;
  }

  async getRole(id: string) {
    return this.getRoleWithAudit(id);
  }

  async getRoleWithAudit(
    id: string,
    actorUserId?: string,
    context?: RequestContext,
  ) {
    const role = await this.dataSource
      .getRepository(UserRoleEntity)
      .findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    if (actorUserId) {
      await this.logAudit({
        actorUserId,
        action: 'admin.role.viewed',
        resourceType: 'user_role',
        resourceId: role.id,
        summary: `Viewed role ${role.name} (${role.code})`,
        metadata: {
          entity: 'user_role',
          template: 'role_viewed',
          role: { id: role.id, code: role.code, name: role.name },
        },
        ...context,
      });
    }

    return role;
  }

  async updateRole(
    id: string,
    dto: UpdateUserRoleDto,
    actorUserId: string,
    context?: RequestContext,
  ) {
    const repo = this.dataSource.getRepository(UserRoleEntity);
    const role = await repo.findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }

    const before = {
      code: role.code,
      name: role.name,
      isSystem: role.isSystem,
    };

    if (dto.code !== undefined) {
      const normalized = dto.code.trim().toLowerCase();
      if (normalized !== role.code) {
        const duplicate = await repo.findOne({ where: { code: normalized } });
        if (duplicate) {
          throw new BadRequestException(
            `Role code "${normalized}" already exists`,
          );
        }
      }
      role.code = normalized;
    }
    if (dto.name !== undefined) role.name = dto.name.trim();
    if (dto.isSystem !== undefined) role.isSystem = dto.isSystem;

    const saved = await repo.save(role);

    await this.logAudit({
      actorUserId,
      action: 'admin.role.updated',
      resourceType: 'user_role',
      resourceId: saved.id,
      summary: `Updated role ${saved.name} (${saved.code})`,
      metadata: {
        entity: 'user_role',
        template: 'role_updated',
        before,
        after: { code: saved.code, name: saved.name, isSystem: saved.isSystem },
      },
      ...context,
    });

    return saved;
  }

  async deleteRole(id: string, actorUserId: string, context?: RequestContext) {
    const roleRepo = this.dataSource.getRepository(UserRoleEntity);
    const userRepo = this.dataSource.getRepository(User);
    const role = await roleRepo.findOne({ where: { id } });
    if (!role) {
      throw new NotFoundException('Role not found');
    }
    if (role.isSystem) {
      throw new BadRequestException('System roles cannot be deleted');
    }

    const assignedUsers = await userRepo.count({ where: { roleId: id } });
    if (assignedUsers > 0) {
      throw new BadRequestException(
        `Cannot delete role with ${assignedUsers} assigned user(s)`,
      );
    }

    await roleRepo.delete({ id });

    await this.logAudit({
      actorUserId,
      action: 'admin.role.deleted',
      resourceType: 'user_role',
      resourceId: id,
      summary: `Deleted role ${role.name} (${role.code})`,
      metadata: {
        entity: 'user_role',
        template: 'role_deleted',
        role: { id: role.id, code: role.code, name: role.name },
      },
      ...context,
    });

    return { success: true, message: 'Role deleted successfully' };
  }

  async listAuditLogs(query: ListAuditLogsQueryDto) {
    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(100, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;

    const repo = this.dataSource.getRepository(AdminAuditLog);
    const alog = ADMIN_AUDIT_LOG_ALIAS;
    const qb = repo
      .createQueryBuilder(alog)
      .orderBy(`${alog}."createdAt"`, 'DESC');

    if (query.search?.trim()) {
      qb.where(`${alog}.summary ILIKE :term`, {
        term: `%${query.search.trim()}%`,
      });
    }

    const [data, total] = await qb.skip(offset).take(limit).getManyAndCount();
    return {
      data,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  private async logAudit(input: {
    actorUserId?: string;
    action: string;
    resourceType: string;
    resourceId?: string;
    summary: string;
    metadata: Record<string, unknown>;
    ipAddress?: string;
    userAgent?: string;
  }) {
    const repo = this.dataSource.getRepository(AdminAuditLog);
    const entity = repo.create({
      actorUserId: input.actorUserId ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      summary: input.summary,
      metadata: input.metadata,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
    });
    await repo.save(entity);
  }
}
