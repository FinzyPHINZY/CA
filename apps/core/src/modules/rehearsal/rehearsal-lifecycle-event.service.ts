import { RehearsalEvent, RehearsalEventType } from '@app/common';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';

@Injectable()
export class RehearsalLifecycleEventService {
  constructor(private readonly dataSource: DataSource) {}

  async log(
    rehearsalId: string,
    eventType: RehearsalEventType,
    options: {
      data?: Record<string, any> | null;
      lineIndex?: number | null;
      characterId?: string | null;
      timestamp?: Date;
      manager?: EntityManager;
    } = {},
  ): Promise<void> {
    const repository = this.getRepository(options.manager);

    await repository.save(
      repository.create({
        rehearsalId,
        eventType,
        lineIndex: options.lineIndex ?? null,
        characterId: options.characterId ?? null,
        data: options.data ?? null,
        timestamp: options.timestamp ?? new Date(),
      }),
    );
  }

  private getRepository(manager?: EntityManager): Repository<RehearsalEvent> {
    return manager
      ? manager.getRepository(RehearsalEvent)
      : this.dataSource.getRepository(RehearsalEvent);
  }
}
