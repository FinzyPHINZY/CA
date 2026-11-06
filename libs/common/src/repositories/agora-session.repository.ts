import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { AgoraSession } from '../entities/agora-session.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class AgoraSessionRepository extends BaseRepository<AgoraSession> {
  constructor(dataSource: DataSource) {
    super(AgoraSession, dataSource.manager);
  }

  async findByChannelName(channelName: string): Promise<AgoraSession | null> {
    return this.findOneBy({ channelName } as any, {
      withDeleted: false,
    });
  }

  async findByBookingId(bookingId: string): Promise<AgoraSession | null> {
    return this.findOneBy({ bookingId } as any, {
      withDeleted: false,
    });
  }

  async findByRehearsalId(rehearsalId: string): Promise<AgoraSession | null> {
    return this.findOneBy({ rehearsalId } as any, {
      withDeleted: false,
    });
  }

  async findActiveByCreatorUserId(
    creatorUserId: string,
  ): Promise<AgoraSession[]> {
    return this.createQueryBuilder('session')
      .where('session.creatorUserId = :creatorUserId', { creatorUserId })
      .andWhere('session.status != :ended', { ended: 'ended' })
      .andWhere('session.deletedAt IS NULL')
      .orderBy('session.createdAt', 'DESC')
      .getMany();
  }
}
