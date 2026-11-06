/** biome-ignore-all lint/style/useImportType: <> */
import { CalendarProvider, ReaderCalendarConnection } from '@app/common';
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DataSource, In } from 'typeorm';
import { CalendarSyncService } from './calendar-sync.service';

@Injectable()
export class CalendarSyncCronService {
  private readonly logger = new Logger(CalendarSyncCronService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly calendarSyncService: CalendarSyncService,
  ) {}

  /**
   * C.3.9 — Run inbound freebusy sync every 30 minutes for all readers
   * who have an active Google or Outlook calendar connection.
   */
  @Cron('*/30 * * * *')
  async syncAllReaderCalendars(): Promise<void> {
    const connRepo = this.dataSource.getRepository(ReaderCalendarConnection);

    const connections = await connRepo.find({
      where: {
        syncEnabled: true,
        provider: In([CalendarProvider.GOOGLE, CalendarProvider.OUTLOOK]),
      },
      select: ['readerProfileId', 'provider'],
    });

    if (connections.length === 0) return;

    this.logger.log(
      `Starting inbound calendar sync for ${connections.length} connections`,
    );

    let synced = 0;
    let failed = 0;
    let errors = 0;

    for (const conn of connections) {
      try {
        const result = await this.calendarSyncService.syncInboundForReader(
          conn.readerProfileId,
        );
        synced += result.synced;
        failed += result.failed;
      } catch (err: any) {
        errors++;
        this.logger.error(
          `Inbound sync failed for readerProfileId ${conn.readerProfileId}: ${err.message}`,
        );
      }
    }

    this.logger.log(
      `Calendar sync complete — connections synced: ${synced}, token failures: ${failed}, errors: ${errors}`,
    );
  }
}
