import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager } from 'typeorm';
import { InjectDataSource } from '@nestjs/typeorm';
import { BaseRepository } from './base.repository';
import { RefreshToken } from '../entities/refresh-token.entity';

@Injectable()
export class RefreshTokenRepository extends BaseRepository<RefreshToken> {
  constructor(@InjectDataSource() dataSource: DataSource) {
    super(RefreshToken, dataSource.createEntityManager());
  }

  /** Find an active (non-revoked, non-expired) token by its hash. */
  async findActiveByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.createQueryBuilder('rt')
      .where('rt.tokenHash = :tokenHash', { tokenHash })
      .andWhere('rt.revokedAt IS NULL')
      .andWhere('rt.expiresAt > NOW()')
      .getOne();
  }

  /** Find any token (including revoked) by its hash — used for replay detection. */
  async findAnyByHash(tokenHash: string): Promise<RefreshToken | null> {
    return this.findOne({ where: { tokenHash } });
  }

  /** Revoke a single token by its hash. Optionally use an existing manager for transactions. */
  async revokeByHash(
    tokenHash: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('tokenHash = :tokenHash AND revokedAt IS NULL', { tokenHash })
        .execute();
    } else {
      await this.createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('tokenHash = :tokenHash AND revokedAt IS NULL', { tokenHash })
        .execute();
    }
  }

  /** Revoke all active tokens belonging to a family (used on replay detection). */
  async revokeAllByFamily(
    family: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('family = :family AND revokedAt IS NULL', { family })
        .execute();
    } else {
      await this.createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('family = :family AND revokedAt IS NULL', { family })
        .execute();
    }
  }

  /** Revoke all active tokens for a user (logout-all / account disable). */
  async revokeAllForUser(
    userId: string,
    manager?: EntityManager,
  ): Promise<void> {
    if (manager) {
      await manager
        .createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('userId = :userId AND revokedAt IS NULL', { userId })
        .execute();
    } else {
      await this.createQueryBuilder()
        .update(RefreshToken)
        .set({ revokedAt: new Date() })
        .where('userId = :userId AND revokedAt IS NULL', { userId })
        .execute();
    }
  }

  /** Purge expired tokens (for maintenance / cron). */
  async deleteExpired(): Promise<void> {
    await this.createQueryBuilder()
      .delete()
      .from(RefreshToken)
      .where('expiresAt < NOW()')
      .execute();
  }
}
