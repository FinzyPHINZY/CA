/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { RehearsalEvent } from '../entities/rehearsal-event.entity';
import { RehearsalEventType } from '../enums/studio.enum';
import { BaseRepository } from './base.repository';

@Injectable()
export class RehearsalEventRepository extends BaseRepository<RehearsalEvent> {
  constructor(dataSource: DataSource) {
    super(RehearsalEvent, dataSource.manager);
  }

  async findByRehearsalId(rehearsalId: string): Promise<RehearsalEvent[]> {
    return this.findManyBy({ rehearsalId } as any, {
      order: { timestamp: 'ASC' },
      withDeleted: false,
    });
  }

  async findByRehearsalIdAndType(
    rehearsalId: string,
    eventType: RehearsalEventType,
  ): Promise<RehearsalEvent[]> {
    return this.findManyBy({ rehearsalId, eventType } as any, {
      order: { timestamp: 'ASC' },
      withDeleted: false,
    });
  }

  async countByRehearsalId(rehearsalId: string): Promise<number> {
    return this.countAll({
      where: { rehearsalId } as any,
      withDeleted: false,
    });
  }

  // Batch insert events for performance during live sessions.
  async createBatch(
    events: Partial<RehearsalEvent>[],
  ): Promise<RehearsalEvent[]> {
    const entities = events.map((e) => this.create(e));
    return this.save(entities);
  }
}
