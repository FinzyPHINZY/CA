import { Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import { SessionExtensionStatus } from '../enums/marketplace.enum';
import { SessionExtension } from '../entities/session-extension.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class SessionExtensionRepository extends BaseRepository<SessionExtension> {
  constructor(dataSource: DataSource) {
    super(SessionExtension, dataSource.manager);
  }

  async findByBookingId(bookingId: string): Promise<SessionExtension[]> {
    return this.findManyBy(
      { bookingId },
      { order: { extensionNumber: 'ASC' } },
    );
  }

  async findPendingByBookingId(
    bookingId: string,
  ): Promise<SessionExtension | null> {
    return this.findOneBy({
      bookingId,
      status: In([
        SessionExtensionStatus.REQUESTED,
        SessionExtensionStatus.APPROVED,
        SessionExtensionStatus.PAYMENT_PENDING,
      ]),
    });
  }

  async findByStripePaymentIntentId(
    stripePaymentIntentId: string,
  ): Promise<SessionExtension | null> {
    return this.findOneBy({ stripePaymentIntentId });
  }

  async countActivatedByBookingId(bookingId: string): Promise<number> {
    return this.count({
      where: { bookingId, status: SessionExtensionStatus.ACTIVE },
      withDeleted: false,
    });
  }

  async findExpiredRequests(
    timeoutSeconds: number,
  ): Promise<SessionExtension[]> {
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
    return this.createQueryBuilder('ext')
      .where('ext.status = :status', {
        status: SessionExtensionStatus.REQUESTED,
      })
      .andWhere('ext.requestedAt <= :cutoff', { cutoff })
      .andWhere('ext.deletedAt IS NULL')
      .getMany();
  }

  async findExpiredPayments(
    timeoutSeconds: number,
  ): Promise<SessionExtension[]> {
    const cutoff = new Date(Date.now() - timeoutSeconds * 1000);
    return this.createQueryBuilder('ext')
      .where('ext.status = :status', {
        status: SessionExtensionStatus.PAYMENT_PENDING,
      })
      .andWhere('ext.approvedAt <= :cutoff', { cutoff })
      .andWhere('ext.deletedAt IS NULL')
      .getMany();
  }
}
