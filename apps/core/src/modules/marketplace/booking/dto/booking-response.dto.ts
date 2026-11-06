import { BaseResponseDto, BookingStatus } from '@app/common';
import { ApiProperty } from '@nestjs/swagger';

export class BookingParticipantDto {
  @ApiProperty({
    description: 'Display name of the booking participant',
    example: 'Ada Nwosu',
    nullable: true,
  })
  name: string | null;

  @ApiProperty({
    description: 'Profile image URL of the booking participant',
    example: 'https://cdn.example.com/avatars/ada.jpg',
    nullable: true,
  })
  avatar: string | null;
}

export class BookingReaderParticipantDto extends BookingParticipantDto {
  @ApiProperty({
    description: 'Reader genres/specialties',
    type: [String],
    example: ['Drama', 'Comedy'],
  })
  genres: string[];
}

export class BookingFinancialStateDto {
  @ApiProperty({ example: 'succeeded', nullable: true })
  paymentStatus: string | null;

  @ApiProperty({ example: 'succeeded', nullable: true })
  refundStatus: string | null;

  @ApiProperty({ example: 'pending_webhook', nullable: true })
  reversalStatus: string | null;

  @ApiProperty({ example: 5000, nullable: true })
  refundAmountCents: number | null;

  @ApiProperty({ example: 'Actor cancelled session', nullable: true })
  refundReason: string | null;

  @ApiProperty({ example: 're_123', nullable: true })
  stripeRefundId: string | null;

  @ApiProperty({ example: 'tr_123', nullable: true })
  stripeTransferId: string | null;

  @ApiProperty({ example: 'trr_123', nullable: true })
  stripeTransferReversalId: string | null;

  @ApiProperty({ example: false })
  actorRefunded: boolean;

  @ApiProperty({ example: false })
  transferReversed: boolean;

  @ApiProperty({ example: false })
  needsManualReview: boolean;

  @ApiProperty({ example: 'refund_failed', nullable: true })
  issueCode: string | null;

  @ApiProperty({
    example: 'Refund failed at payment processor',
    nullable: true,
  })
  issueMessage: string | null;

  @ApiProperty({
    example: 'retry_refund',
    nullable: true,
    enum: ['retry_refund', 'manual_stripe_review', null],
  })
  recommendedAction: 'retry_refund' | 'manual_stripe_review' | null;
}

export class BookingRehearsalSummaryDto {
  @ApiProperty({
    example: '623e4567-e89b-12d3-a456-426614174005',
    nullable: true,
  })
  id: string | null;

  @ApiProperty({ example: 'CREATED', nullable: true })
  status: string | null;

  @ApiProperty({ example: 'READER_BOOKED', nullable: true })
  mode: string | null;

  @ApiProperty({ example: 'STUDIO', nullable: true })
  runtimeEngine: string | null;
}

export class BookingDto {
  @ApiProperty({ example: '123e4567-e89b-12d3-a456-426614174000' })
  id: string;

  @ApiProperty({ example: '223e4567-e89b-12d3-a456-426614174001' })
  actorUserId: string;

  @ApiProperty({ example: '323e4567-e89b-12d3-a456-426614174002' })
  readerUserId: string;

  @ApiProperty({ example: '423e4567-e89b-12d3-a456-426614174003' })
  readerProfileId: string;

  @ApiProperty({ example: '523e4567-e89b-12d3-a456-426614174004' })
  timeSlotId: string;

  @ApiProperty({ enum: BookingStatus, example: BookingStatus.HELD })
  status: string;

  @ApiProperty({ example: 30 })
  sessionDurationMinutes: number;

  @ApiProperty({ example: 5000 })
  priceCents: number;

  @ApiProperty({ example: 'USD' })
  currency: string;

  @ApiProperty({ example: 750 })
  platformFeeCents: number;

  @ApiProperty({ example: 'pi_123', nullable: true })
  stripePaymentIntentId?: string | null;

  @ApiProperty({ example: 'Cancelled by actor', nullable: true })
  cancellationReason?: string | null;

  @ApiProperty({ example: 'actor', nullable: true })
  cancelledBy?: string | null;

  @ApiProperty({ example: '2026-03-13T09:00:00.000Z', nullable: true })
  cancelledAt?: Date | null;

  @ApiProperty({ example: '2026-03-13T10:30:00.000Z', nullable: true })
  completedAt?: Date | null;

  @ApiProperty({ example: '2026-03-20T14:00:00.000Z' })
  sessionStartUtc: Date;

  @ApiProperty({ example: '2026-03-20T14:30:00.000Z' })
  sessionEndUtc: Date;

  @ApiProperty({ example: null, nullable: true })
  metaData?: Record<string, any> | null;

  @ApiProperty({ type: BookingParticipantDto })
  actor: BookingParticipantDto;

  @ApiProperty({ type: BookingReaderParticipantDto })
  reader: BookingReaderParticipantDto;

  @ApiProperty({
    type: BookingRehearsalSummaryDto,
    nullable: true,
  })
  rehearsal: BookingRehearsalSummaryDto | null;

  @ApiProperty({ example: '2026-03-13T08:55:00.000Z' })
  createdAt: Date;

  @ApiProperty({ example: '2026-03-13T08:55:00.000Z' })
  updatedAt: Date;
}

export class BookingFeeBreakdownDto {
  @ApiProperty({ example: 5000 })
  actorPaysCents: number;

  @ApiProperty({ example: 750 })
  platformFeeCents: number;

  @ApiProperty({ example: 4250 })
  readerReceivesCents: number;
}

export class CreateBookingResponseDataDto {
  @ApiProperty({ type: BookingDto })
  booking: BookingDto;

  @ApiProperty({ type: BookingFeeBreakdownDto })
  fees: BookingFeeBreakdownDto;
}

export class CreateBookingResponseDto extends BaseResponseDto {
  @ApiProperty({ type: CreateBookingResponseDataDto })
  data: CreateBookingResponseDataDto;
}

export class CreateBookingPaymentIntentDataDto {
  @ApiProperty({
    description: 'Stripe client secret used by Stripe.js to confirm payment',
    example: 'pi_3QabcXYZ_secret_123',
  })
  clientSecret: string;

  @ApiProperty({
    description: 'Stripe PaymentIntent identifier for the held booking payment',
    example: 'pi_3QabcXYZ',
  })
  paymentIntentId: string;
}

export class CreateBookingPaymentIntentResponseDto extends BaseResponseDto {
  @ApiProperty({ type: CreateBookingPaymentIntentDataDto })
  data: CreateBookingPaymentIntentDataDto;
}

export class BookingDetailDto extends BookingDto {
  @ApiProperty({ type: BookingFinancialStateDto })
  financialState: BookingFinancialStateDto;
}

export class GetBookingResponseDto extends BaseResponseDto {
  @ApiProperty({ type: BookingDetailDto })
  data: BookingDetailDto;
}

export class ListBookingsDataDto {
  @ApiProperty({ type: [BookingDetailDto] })
  items: BookingDetailDto[];

  @ApiProperty({ example: 24 })
  total: number;

  @ApiProperty({ example: 1 })
  page: number;

  @ApiProperty({ example: 20 })
  limit: number;

  @ApiProperty({ example: 2 })
  totalPages: number;

  @ApiProperty({ example: true })
  hasNext: boolean;

  @ApiProperty({ example: false })
  hasPrev: boolean;
}

export class ListBookingsResponseDto extends BaseResponseDto {
  @ApiProperty({ type: ListBookingsDataDto })
  data: ListBookingsDataDto;
}
