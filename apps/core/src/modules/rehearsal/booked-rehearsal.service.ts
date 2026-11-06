/** biome-ignore-all lint/suspicious/noExplicitAny: <> */
import {
  Booking,
  BookingStatus,
  RehearsalEventType,
  RehearsalMode,
  RehearsalPartnerType,
  RehearsalRuntimeEngine,
  RehearsalStatus,
  Rehersal,
  RehersalRepository,
} from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { DataSource, EntityManager, In, Repository } from 'typeorm';
import { RehearsalLifecycleEventService } from './rehearsal-lifecycle-event.service';

@Injectable()
export class BookedRehearsalService {
  private readonly logger = new Logger(BookedRehearsalService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly rehersalRepository: RehersalRepository,
    private readonly rehearsalLifecycleEventService: RehearsalLifecycleEventService,
  ) {}

  async ensureForBooking(
    booking: Booking,
    manager?: EntityManager,
  ): Promise<Rehersal> {
    const repository = this.getRepository(manager);
    const existing = await repository.findOne({
      where: { bookingId: booking.id },
    });

    if (existing) {
      const nextMetaData = this.mergeMetaData(existing.metaData, booking);
      const compatibilityState = this.deriveCompatibilityState(booking);
      const needsSync =
        existing.userId !== booking.actorUserId ||
        existing.rehearsalPartnerUserId !== booking.readerUserId ||
        existing.mode !== RehearsalMode.READER_BOOKED ||
        existing.runtimeEngine !== RehearsalRuntimeEngine.STUDIO ||
        existing.status !== compatibilityState.status ||
        this.dateValue(existing.startedAt) !==
          this.dateValue(compatibilityState.startedAt) ||
        this.dateValue(existing.endedAt) !==
          this.dateValue(compatibilityState.endedAt) ||
        existing.sessionDurationSeconds !==
          compatibilityState.sessionDurationSeconds ||
        JSON.stringify(existing.metaData ?? null) !==
          JSON.stringify(nextMetaData);

      if (needsSync) {
        Object.assign(existing, {
          userId: booking.actorUserId,
          rehearsalPartnerType: RehearsalPartnerType.USER,
          rehearsalPartnerUserId: booking.readerUserId,
          rehearsalPartnerAiName: null,
          rehearsalPartnerAiDescription: null,
          rehearsalPartnerAiImage: null,
          mode: RehearsalMode.READER_BOOKED,
          runtimeEngine: RehearsalRuntimeEngine.STUDIO,
          status: compatibilityState.status,
          startedAt: compatibilityState.startedAt,
          endedAt: compatibilityState.endedAt,
          sessionDurationSeconds: compatibilityState.sessionDurationSeconds,
          metaData: nextMetaData,
        });
        const saved = await repository.save(existing);
        this.logger.debug(
          `Booked rehearsal ${saved.id} synchronized for booking ${booking.id}`,
        );
        return saved;
      }

      return existing;
    }

    const compatibilityState = this.deriveCompatibilityState(booking);
    const rehearsal = repository.create({
      userId: booking.actorUserId,
      bookingId: booking.id,
      projectId: null,
      scriptId: null,
      sceneId: null,
      rehearsalPartnerType: RehearsalPartnerType.USER,
      rehearsalPartnerUserId: booking.readerUserId,
      rehearsalPartnerAiName: null,
      rehearsalPartnerAiDescription: null,
      rehearsalPartnerAiImage: null,
      mode: RehearsalMode.READER_BOOKED,
      runtimeEngine: RehearsalRuntimeEngine.STUDIO,
      status: compatibilityState.status,
      characterId: null,
      startedAt: compatibilityState.startedAt,
      endedAt: compatibilityState.endedAt,
      sessionDurationSeconds: compatibilityState.sessionDurationSeconds,
      metaData: this.mergeMetaData(null, booking),
    });

    const saved = await repository.save(rehearsal);
    await this.logCompatibilityLifecycleEvents(saved, booking, manager);
    this.logger.log(
      `Booked rehearsal ${saved.id} created for booking ${booking.id}`,
    );
    return saved;
  }

  async findByBookingId(bookingId: string): Promise<Rehersal | null> {
    return this.rehersalRepository.findByBookingId(bookingId);
  }

  async findManyByBookingIds(bookingIds: string[]): Promise<Rehersal[]> {
    if (bookingIds.length === 0) {
      return [];
    }

    return this.dataSource.getRepository(Rehersal).find({
      where: { bookingId: In(bookingIds) },
    });
  }

  async markActive(
    booking: Booking,
    startedAt: Date = new Date(),
  ): Promise<void> {
    const rehearsal = await this.ensureForBooking(booking);
    const nextMetaData = this.mergeMetaData(rehearsal.metaData, booking);
    const shouldLogStarted = rehearsal.status !== RehearsalStatus.ACTIVE;

    // Settings are frozen at the actor's WebSocket session.start, not at
    // booking activation. The ACTIVE status set below is what locks edits;
    // the snapshot is bookkeeping written when the session actually begins.

    await this.rehersalRepository.updateById(rehearsal.id, {
      status: RehearsalStatus.ACTIVE,
      runtimeEngine: RehearsalRuntimeEngine.STUDIO,
      startedAt: rehearsal.startedAt ?? startedAt,
      endedAt: null,
      metaData: nextMetaData,
    });

    if (shouldLogStarted) {
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_STARTED,
        {
          timestamp: startedAt,
          data: {
            bookingId: booking.id,
            runtimeEngine: RehearsalRuntimeEngine.STUDIO,
          },
        },
      );
    }
  }

  async markCompleted(
    booking: Booking,
    endedAt: Date = booking.completedAt ?? new Date(),
    manager?: EntityManager,
  ): Promise<void> {
    const rehearsal = await this.ensureForBooking(booking, manager);
    const shouldLogCompleted = rehearsal.status !== RehearsalStatus.COMPLETED;

    if (manager) {
      await this.getRepository(manager).update(rehearsal.id, {
        status: RehearsalStatus.COMPLETED,
        runtimeEngine: RehearsalRuntimeEngine.STUDIO,
        endedAt,
        sessionDurationSeconds: this.computeSessionDurationSeconds(
          rehearsal.startedAt,
          endedAt,
          rehearsal.sessionDurationSeconds,
        ),
        metaData: this.mergeMetaData(rehearsal.metaData, booking),
      });
      if (shouldLogCompleted) {
        await this.rehearsalLifecycleEventService.log(
          rehearsal.id,
          RehearsalEventType.SESSION_COMPLETED,
          {
            manager,
            timestamp: endedAt,
            data: {
              bookingId: booking.id,
              runtimeEngine: RehearsalRuntimeEngine.STUDIO,
            },
          },
        );
      }
      return;
    }

    await this.rehersalRepository.updateById(rehearsal.id, {
      status: RehearsalStatus.COMPLETED,
      runtimeEngine: RehearsalRuntimeEngine.STUDIO,
      endedAt,
      sessionDurationSeconds: this.computeSessionDurationSeconds(
        rehearsal.startedAt,
        endedAt,
        rehearsal.sessionDurationSeconds,
      ),
      metaData: this.mergeMetaData(rehearsal.metaData, booking),
    });

    if (shouldLogCompleted) {
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_COMPLETED,
        {
          timestamp: endedAt,
          data: {
            bookingId: booking.id,
            runtimeEngine: RehearsalRuntimeEngine.STUDIO,
          },
        },
      );
    }
  }

  async markCancelledByBookingId(
    bookingId: string,
    bookingMeta?: Partial<Booking>,
    manager?: EntityManager,
  ): Promise<void> {
    const rehearsal = manager
      ? await this.getRepository(manager).findOne({ where: { bookingId } })
      : await this.rehersalRepository.findByBookingId(bookingId);
    if (!rehearsal) {
      return;
    }

    const endedAt = rehearsal.endedAt ?? new Date();
    const nextMetaData = bookingMeta
      ? this.mergeMetaData(rehearsal.metaData, bookingMeta)
      : rehearsal.metaData;
    const shouldLogCancelled = rehearsal.status !== RehearsalStatus.CANCELLED;

    if (manager) {
      await this.getRepository(manager).update(rehearsal.id, {
        status: RehearsalStatus.CANCELLED,
        runtimeEngine: RehearsalRuntimeEngine.STUDIO,
        endedAt,
        sessionDurationSeconds: this.computeSessionDurationSeconds(
          rehearsal.startedAt,
          endedAt,
          rehearsal.sessionDurationSeconds,
        ),
        metaData: nextMetaData,
      });
      if (shouldLogCancelled) {
        await this.rehearsalLifecycleEventService.log(
          rehearsal.id,
          RehearsalEventType.SESSION_CANCELLED,
          {
            manager,
            timestamp: endedAt,
            data: {
              bookingId,
              runtimeEngine: RehearsalRuntimeEngine.STUDIO,
              bookingStatus: bookingMeta?.status ?? null,
            },
          },
        );
      }
      return;
    }

    await this.rehersalRepository.updateById(rehearsal.id, {
      status: RehearsalStatus.CANCELLED,
      runtimeEngine: RehearsalRuntimeEngine.STUDIO,
      endedAt,
      sessionDurationSeconds: this.computeSessionDurationSeconds(
        rehearsal.startedAt,
        endedAt,
        rehearsal.sessionDurationSeconds,
      ),
      metaData: nextMetaData,
    });

    if (shouldLogCancelled) {
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_CANCELLED,
        {
          timestamp: endedAt,
          data: {
            bookingId,
            runtimeEngine: RehearsalRuntimeEngine.STUDIO,
            bookingStatus: bookingMeta?.status ?? null,
          },
        },
      );
    }
  }

  private getRepository(manager?: EntityManager): Repository<Rehersal> {
    return manager
      ? manager.getRepository(Rehersal)
      : this.dataSource.getRepository(Rehersal);
  }

  private deriveCompatibilityState(booking: Booking): {
    status: RehearsalStatus;
    startedAt: Date | null;
    endedAt: Date | null;
    sessionDurationSeconds: number | null;
  } {
    switch (booking.status) {
      case BookingStatus.IN_PROGRESS:
        return {
          status: RehearsalStatus.ACTIVE,
          startedAt: booking.sessionStartUtc ?? null,
          endedAt: null,
          sessionDurationSeconds: null,
        };
      case BookingStatus.COMPLETED: {
        const startedAt = booking.sessionStartUtc ?? null;
        const endedAt = booking.completedAt ?? booking.sessionEndUtc ?? null;
        return {
          status: RehearsalStatus.COMPLETED,
          startedAt,
          endedAt,
          sessionDurationSeconds: this.computeSessionDurationSeconds(
            startedAt,
            endedAt,
            null,
          ),
        };
      }
      case BookingStatus.CANCELLED:
      case BookingStatus.NO_SHOW: {
        const startedAt =
          booking.status === BookingStatus.NO_SHOW
            ? (booking.sessionStartUtc ?? null)
            : null;
        const endedAt =
          booking.cancelledAt ??
          booking.completedAt ??
          booking.sessionEndUtc ??
          new Date();
        return {
          status: RehearsalStatus.CANCELLED,
          startedAt,
          endedAt,
          sessionDurationSeconds: this.computeSessionDurationSeconds(
            startedAt,
            endedAt,
            null,
          ),
        };
      }
      case BookingStatus.CONFIRMED:
      case BookingStatus.HELD:
      default:
        return {
          status: RehearsalStatus.CREATED,
          startedAt: null,
          endedAt: null,
          sessionDurationSeconds: null,
        };
    }
  }

  private async logCompatibilityLifecycleEvents(
    rehearsal: Rehersal,
    booking: Booking,
    manager?: EntityManager,
  ): Promise<void> {
    const baseData = {
      mode: rehearsal.mode,
      runtimeEngine: rehearsal.runtimeEngine,
      source: 'booking',
      bookingId: booking.id,
    };

    await this.rehearsalLifecycleEventService.log(
      rehearsal.id,
      RehearsalEventType.SESSION_CREATED,
      {
        manager,
        data: baseData,
        timestamp: rehearsal.createdAt,
      },
    );

    if (rehearsal.status === RehearsalStatus.ACTIVE && rehearsal.startedAt) {
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_STARTED,
        {
          manager,
          timestamp: rehearsal.startedAt,
          data: {
            ...baseData,
            backfilled: true,
          },
        },
      );
    }

    if (rehearsal.status === RehearsalStatus.COMPLETED && rehearsal.endedAt) {
      if (rehearsal.startedAt) {
        await this.rehearsalLifecycleEventService.log(
          rehearsal.id,
          RehearsalEventType.SESSION_STARTED,
          {
            manager,
            timestamp: rehearsal.startedAt,
            data: {
              ...baseData,
              backfilled: true,
            },
          },
        );
      }
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_COMPLETED,
        {
          manager,
          timestamp: rehearsal.endedAt,
          data: {
            ...baseData,
            backfilled: true,
          },
        },
      );
    }

    if (rehearsal.status === RehearsalStatus.CANCELLED && rehearsal.endedAt) {
      await this.rehearsalLifecycleEventService.log(
        rehearsal.id,
        RehearsalEventType.SESSION_CANCELLED,
        {
          manager,
          timestamp: rehearsal.endedAt,
          data: {
            ...baseData,
            bookingStatus: booking.status,
            backfilled: true,
          },
        },
      );
    }
  }

  private dateValue(value: Date | null | undefined): string | null {
    return value ? value.toISOString() : null;
  }

  private computeSessionDurationSeconds(
    startedAt: Date | null,
    endedAt: Date | null,
    fallback: number | null,
  ): number | null {
    if (!startedAt || !endedAt) {
      return fallback ?? null;
    }

    return Math.max(
      0,
      Math.floor((endedAt.getTime() - startedAt.getTime()) / 1000),
    );
  }

  private mergeMetaData(
    current: Record<string, any> | null,
    booking: Partial<Booking>,
  ): Record<string, any> {
    return {
      ...(current ?? {}),
      source: 'booking',
      setup: {
        ...(current?.setup ?? {}),
        characterSelectionRequired: false,
        characterSelected: false,
      },
      booking: {
        ...(current?.booking ?? {}),
        bookingId: booking.id ?? current?.booking?.bookingId ?? null,
        readerProfileId:
          booking.readerProfileId ?? current?.booking?.readerProfileId ?? null,
        sessionDurationMinutes:
          booking.sessionDurationMinutes ??
          current?.booking?.sessionDurationMinutes ??
          null,
        sessionStartUtc:
          booking.sessionStartUtc?.toISOString?.() ??
          current?.booking?.sessionStartUtc ??
          null,
        sessionEndUtc:
          booking.sessionEndUtc?.toISOString?.() ??
          current?.booking?.sessionEndUtc ??
          null,
        bookingStatus:
          booking.status ?? current?.booking?.bookingStatus ?? null,
      },
    };
  }
}
