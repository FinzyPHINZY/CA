/** biome-ignore-all lint/style/useImportType: <> */
/** biome-ignore-all lint/suspicious/noExplicitAny: <> */

import { Booking, PaymentRecord, PaymentRecordStatus } from '@app/common';
import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { ConnectPaymentService } from './connect-payment.service';
import { RefundOrchestrationService } from './refund-orchestration.service';

function mockRepository(overrides: Record<string, jest.Mock> = {}) {
  return {
    findOne: jest.fn(),
    save: jest.fn((entity) => Promise.resolve(entity)),
    ...overrides,
  };
}

describe('RefundOrchestrationService', () => {
  let service: RefundOrchestrationService;
  let bookingRepo: ReturnType<typeof mockRepository>;
  let paymentRecordRepo: ReturnType<typeof mockRepository>;
  let connectPaymentService: jest.Mocked<Partial<ConnectPaymentService>>;

  const bookingId = 'booking-1';
  const booking = {
    id: bookingId,
    metaData: null,
  } as unknown as Booking;

  const basePaymentRecord = {
    id: 'pr_1',
    bookingId,
    actorUserId: 'actor-1',
    readerUserId: 'reader-1',
    stripePaymentIntentId: 'pi_123',
    amountCents: 10000,
    platformFeeCents: 1500,
    readerPayoutCents: 8500,
    currency: 'USD',
    status: PaymentRecordStatus.SUCCEEDED,
    refundMetaData: null,
  } as unknown as PaymentRecord;

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();

    bookingRepo = mockRepository();
    paymentRecordRepo = mockRepository();

    const repoMap: Record<string, ReturnType<typeof mockRepository>> = {
      [Booking.name]: bookingRepo,
      [PaymentRecord.name]: paymentRecordRepo,
    };

    const dataSource = {
      getRepository: jest.fn((entity: any) => repoMap[entity.name]),
    } as unknown as DataSource;

    connectPaymentService = {
      refundPaymentIntent: jest.fn(),
    };

    const mockConfigService = { get: jest.fn().mockReturnValue(null) } as any;
    service = new RefundOrchestrationService(
      dataSource,
      connectPaymentService as unknown as ConnectPaymentService,
      mockConfigService,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('throws when booking does not exist', async () => {
    bookingRepo.findOne.mockResolvedValue(null);

    await expect(
      service.processBookingRefund(bookingId, {
        amountCents: 10000,
        reason: 'Reader cancelled',
        outcomeCode: 'reader_cancel',
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('skips when there is no Stripe payment intent', async () => {
    bookingRepo.findOne.mockResolvedValue(booking);
    paymentRecordRepo.findOne.mockResolvedValue({
      ...basePaymentRecord,
      stripePaymentIntentId: null,
    });

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 10000,
      reason: 'Reader cancelled',
      outcomeCode: 'reader_cancel',
    });

    expect(result.action).toBe('skipped');
    expect(connectPaymentService.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it('skips when a refund is already recorded', async () => {
    bookingRepo.findOne.mockResolvedValue(booking);
    paymentRecordRepo.findOne.mockResolvedValue({
      ...basePaymentRecord,
      status: PaymentRecordStatus.REFUNDED,
      stripeRefundId: 're_123',
      refundStatus: 'succeeded',
      reversalStatus: 'succeeded',
    });

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 10000,
      reason: 'Reader cancelled',
      outcomeCode: 'reader_cancel',
    });

    expect(result.action).toBe('skipped');
    expect(result.refundId).toBe('re_123');
    expect(connectPaymentService.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it('throws when payment record is not refundable', async () => {
    bookingRepo.findOne.mockResolvedValue(booking);
    paymentRecordRepo.findOne.mockResolvedValue({
      ...basePaymentRecord,
      status: PaymentRecordStatus.FAILED,
    });

    await expect(
      service.processBookingRefund(bookingId, {
        amountCents: 10000,
        reason: 'Reader cancelled',
        outcomeCode: 'reader_cancel',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('skips zero-value refunds without calling Stripe', async () => {
    bookingRepo.findOne.mockResolvedValue(booking);
    paymentRecordRepo.findOne.mockResolvedValue(basePaymentRecord);

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 0,
      reason: 'No refund',
      outcomeCode: 'actor_cancel',
    });

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('Refund amount is zero');
    expect(connectPaymentService.refundPaymentIntent).not.toHaveBeenCalled();
  });

  it('processes a full refund with reversal required', async () => {
    bookingRepo.findOne
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    paymentRecordRepo.findOne
      .mockResolvedValueOnce({ ...basePaymentRecord })
      .mockResolvedValueOnce({
        ...basePaymentRecord,
        refundMetaData: {},
      });
    connectPaymentService.refundPaymentIntent!.mockResolvedValue({
      id: 're_123',
      status: 'succeeded',
      transfer_reversal: 'trr_123',
      source_transfer_reversal: null,
    } as any);

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 10000,
      reason: 'Reader cancelled',
      outcomeCode: 'reader_cancel',
      reverseTransfer: true,
      refundApplicationFee: true,
    });

    expect(connectPaymentService.refundPaymentIntent).toHaveBeenCalledWith(
      'pi_123',
      expect.objectContaining({
        amountCents: 10000,
        reverseTransfer: true,
        refundApplicationFee: true,
        idempotencyResourceKey: 'booking:booking-1:reader_cancel:10000',
      }),
    );
    expect(result.action).toBe('refunded');
    expect(result.transferReversalId).toBe('trr_123');
    expect(result.reversalStatus).toBe('pending_webhook');
  });

  it('processes a partial refund without reversal when not requested', async () => {
    bookingRepo.findOne
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    paymentRecordRepo.findOne
      .mockResolvedValueOnce({ ...basePaymentRecord })
      .mockResolvedValueOnce({
        ...basePaymentRecord,
        refundMetaData: {},
      });
    connectPaymentService.refundPaymentIntent!.mockResolvedValue({
      id: 're_456',
      status: 'succeeded',
      transfer_reversal: null,
      source_transfer_reversal: null,
    } as any);

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 5000,
      reason: '50% refund',
      outcomeCode: 'actor_cancel',
      reverseTransfer: false,
      refundApplicationFee: false,
    });

    expect(connectPaymentService.refundPaymentIntent).toHaveBeenCalledWith(
      'pi_123',
      expect.objectContaining({
        amountCents: 5000,
        reverseTransfer: false,
        refundApplicationFee: false,
      }),
    );
    expect(result.refundId).toBe('re_456');
    expect(result.reversalStatus).toBe('not_required');
  });

  // ─── Separate charges ────────────────────────────────────────────

  it('processes a pre-settlement separate-charge refund without reversal', async () => {
    const separatePayment = {
      ...basePaymentRecord,
      paymentModel: 'separate',
      settlementStatus: 'pending',
    };

    bookingRepo.findOne
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    paymentRecordRepo.findOne
      .mockResolvedValueOnce(separatePayment)
      .mockResolvedValueOnce({ ...separatePayment, refundMetaData: {} });
    connectPaymentService.refundPaymentIntent!.mockResolvedValue({
      id: 're_sep_1',
      status: 'succeeded',
      transfer_reversal: null,
      source_transfer_reversal: null,
    } as any);

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 10000,
      reason: 'Cancelled pre-settlement',
      outcomeCode: 'actor_cancel',
      reverseTransfer: true, // caller says true, but orchestrator should override
      refundApplicationFee: true,
    });

    expect(result.action).toBe('refunded');
    // Verify refund was called WITHOUT reverseTransfer (separate charges)
    expect(connectPaymentService.refundPaymentIntent).toHaveBeenCalledWith(
      'pi_123',
      expect.objectContaining({
        reverseTransfer: false,
        refundApplicationFee: false,
      }),
    );
  });

  it('reverses transfer before refunding a post-settlement separate-charge payment', async () => {
    const settledPayment = {
      ...basePaymentRecord,
      paymentModel: 'separate',
      settlementStatus: 'settled',
      stripeTransferId: 'tr_settled_1',
    };

    // Mock Stripe for transfer reversal
    const mockStripe = {
      transfers: {
        createReversal: jest.fn().mockResolvedValue({ id: 'trr_sep_1' }),
      },
    };
    (service as any).stripe = mockStripe;

    bookingRepo.findOne
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    paymentRecordRepo.findOne
      .mockResolvedValueOnce(settledPayment)
      .mockResolvedValueOnce({ ...settledPayment, refundMetaData: {} });
    connectPaymentService.refundPaymentIntent!.mockResolvedValue({
      id: 're_post_settle',
      status: 'succeeded',
      transfer_reversal: null,
      source_transfer_reversal: null,
    } as any);

    const result = await service.processBookingRefund(bookingId, {
      amountCents: 10000,
      reason: 'Post-settlement refund',
      outcomeCode: 'admin_refund',
    });

    expect(result.action).toBe('refunded');
    // Verify transfer was reversed first
    expect(mockStripe.transfers.createReversal).toHaveBeenCalledWith(
      'tr_settled_1',
      expect.objectContaining({
        amount: 8500, // readerPayoutCents proportional to full refund
      }),
    );
    // Verify payment record has reversal ID
    expect(paymentRecordRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        stripeTransferReversalId: 'trr_sep_1',
        reversalStatus: 'succeeded',
      }),
    );
  });

  it('marks manual review when the Stripe refund request fails', async () => {
    bookingRepo.findOne
      .mockResolvedValueOnce(booking)
      .mockResolvedValueOnce(booking);
    paymentRecordRepo.findOne
      .mockResolvedValueOnce({ ...basePaymentRecord })
      .mockResolvedValueOnce({
        ...basePaymentRecord,
        refundMetaData: {},
      });
    connectPaymentService.refundPaymentIntent!.mockRejectedValue(
      new Error('stripe exploded'),
    );

    await expect(
      service.processBookingRefund(bookingId, {
        amountCents: 10000,
        reason: 'Reader no-show',
        outcomeCode: 'reader_no_show',
      }),
    ).rejects.toThrow('stripe exploded');

    expect(paymentRecordRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        refundStatus: 'failed',
        refundFailureReason: 'stripe exploded',
      }),
    );
    expect(bookingRepo.save).toHaveBeenCalledWith(
      expect.objectContaining({
        metaData: expect.objectContaining({
          financialIssue: expect.objectContaining({
            issueCode: 'refund_request_failed',
          }),
        }),
      }),
    );
  });
});
