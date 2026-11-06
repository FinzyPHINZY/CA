import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PaymentRecord } from '../entities/payment-record.entity';
import { BaseRepository } from './base.repository';

@Injectable()
export class PaymentRecordRepository extends BaseRepository<PaymentRecord> {
  constructor(dataSource: DataSource) {
    super(PaymentRecord, dataSource.manager);
  }

  async findByBookingId(bookingId: string): Promise<PaymentRecord | null> {
    return this.findOneBy({ bookingId });
  }

  async findByStripePaymentIntentId(
    stripePaymentIntentId: string,
  ): Promise<PaymentRecord | null> {
    return this.findOneBy({ stripePaymentIntentId });
  }
}
