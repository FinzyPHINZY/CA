import { ApiProperty } from '@nestjs/swagger';

export class PaymentsSummaryDto {
  @ApiProperty({
    description: 'Total count of active subscriptions',
    example: 1425,
  })
  totalActiveSubs: number;

  @ApiProperty({
    description:
      'Net change in active subscriptions this month (new - churned)',
    example: 12,
  })
  totalActiveSubsChange: number;

  @ApiProperty({
    description: 'Monthly recurring revenue in USD',
    example: 21810,
  })
  mrr: number;

  @ApiProperty({
    description: 'Net change in MRR this month in USD',
    example: 930,
  })
  mrrChange: number;

  @ApiProperty({
    description: 'Total refund amount in USD',
    example: 219.02,
  })
  refundsTotal: number;

  @ApiProperty({
    description: 'Count of failed payments',
    example: 12,
  })
  failedPaymentsCount: number;
}
