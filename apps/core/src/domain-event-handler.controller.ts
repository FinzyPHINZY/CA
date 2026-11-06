/** biome-ignore-all lint/style/useImportType: <> */
import {
  Availability,
  EVENT_PATTERNS,
  Project,
  Recording,
  Rehersal,
  Script,
  TimeSlot,
  type UserDeletedEvent,
  type UserUpdatedEvent,
} from '@app/common';
import { Controller, Injectable, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { DataSource, IsNull, Not } from 'typeorm';
import { SlotGenerationService } from './modules/marketplace/booking/slot-generation.service';


@Controller()
@Injectable()
export class DomainEventHandlerController {
  private readonly logger = new Logger(DomainEventHandlerController.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly slotGenerationService: SlotGenerationService,
  ) {}


  @EventPattern(EVENT_PATTERNS.USER_DELETED)
  async handleUserDeleted(
    @Payload() event: Omit<UserDeletedEvent, 'pattern'>,
  ): Promise<void> {
    const { userId, email, isSoftDelete } = event;

    this.logger.log(
      `Received user.deleted event for user ${userId} (${email}), isSoftDelete: ${isSoftDelete}`,
    );

    try {
      await this.dataSource.transaction(async (manager) => {
        const projectCount = await manager.count(Project, {
          where: { userId },
        });
        const scriptCount = await manager.count(Script, { where: { userId } });
        const recordingCount = await manager.count(Recording, {
          where: { userId },
        });
        const rehearsalCount = await manager.count(Rehersal, {
          where: { userId },
        });

        this.logger.log(
          `User ${userId} has: ${projectCount} projects, ${scriptCount} scripts, ` +
            `${recordingCount} recordings, ${rehearsalCount} rehearsals`,
        );

         if (rehearsalCount > 0) {
          await manager.delete(Rehersal, { userId });
          this.logger.log(
            `Deleted ${rehearsalCount} rehearsals for user ${userId}`,
          );
        }

        if (recordingCount > 0) {
          await manager.delete(Recording, { userId });
          this.logger.log(
            `Deleted ${recordingCount} recordings for user ${userId}`,
          );
        }

        if (scriptCount > 0) {
          await manager.delete(Script, { userId });
          this.logger.log(`Deleted ${scriptCount} scripts for user ${userId}`);
        }

        if (projectCount > 0) {
          await manager.delete(Project, { userId });
          this.logger.log(
            `Deleted ${projectCount} projects for user ${userId}`,
          );
        }

        this.logger.log(
          `Successfully processed user.deleted event for user ${userId}`,
        );
      });
    } catch (error) {
      this.logger.error(
        `Failed to process user.deleted event for user ${userId}:`,
        error,
      );
      throw error;
    }
  }


  @EventPattern(EVENT_PATTERNS.USER_UPDATED)
  async handleUserUpdated(
    @Payload() event: Omit<UserUpdatedEvent, 'pattern'>,
  ): Promise<void> {
    const { userId, updatedFields } = event;

    if (!updatedFields.includes('timezone')) {
      return;
    }

    this.logger.log(
      `Timezone changed for user ${userId} — regenerating availability slots`,
    );

    try {
      const slotRepo = this.dataSource.getRepository(TimeSlot);
      const availRepo = this.dataSource.getRepository(Availability);

      const availability = await availRepo.findOne({ where: { userId } });
      if (!availability) {
        this.logger.log(
          `No availability found for user ${userId}, skipping slot regeneration`,
        );
        return;
      }

      const now = new Date();
      const deleted = await slotRepo
        .createQueryBuilder()
        .delete()
        .where('"availabilityId" = :availId', { availId: availability.id })
        .andWhere('date IS NOT NULL')
        .andWhere('"startTimeUtc" > :now', { now })
        .execute();

      this.logger.log(
        `Deleted ${deleted.affected || 0} stale future slots for user ${userId}`,
      );

      const generated =
        await this.slotGenerationService.generateSlotsForReader(userId);
      this.logger.log(
        `Regenerated ${generated} slots for user ${userId} with updated timezone`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to regenerate slots after timezone change for user ${userId}:`,
        error,
      );
      throw error;
    }
  }
}
