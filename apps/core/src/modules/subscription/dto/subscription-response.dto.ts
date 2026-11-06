import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SubscriptionPlan, SubscriptionStatus } from '@app/common';

export class SubscriptionResponseDto {
  @ApiProperty({
    description: 'Unique subscription identifier',
    example: '123e4567-e89b-12d3-a456-426614174000',
    format: 'uuid',
  })
  id: string;

  @ApiProperty({
    description: 'User ID who owns this subscription',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
    format: 'uuid',
  })
  userId: string;

  @ApiProperty({
    description: 'Subscription plan type',
    enum: SubscriptionPlan,
    example: SubscriptionPlan.PREMIUM,
    enumName: 'SubscriptionPlan',
  })
  plan: SubscriptionPlan;

  @ApiProperty({
    description: 'Current subscription status',
    enum: SubscriptionStatus,
    example: SubscriptionStatus.ACTIVE,
    enumName: 'SubscriptionStatus',
  })
  status: SubscriptionStatus;

  @ApiProperty({
    description: 'Subscription expiration date and time',
    example: '2025-02-15T10:30:00.000Z',
    type: String,
    format: 'date-time',
  })
  expiresAt: Date;

  @ApiPropertyOptional({
    description: 'Stripe customer ID associated with this subscription',
    example: 'cus_1234567890',
    nullable: true,
  })
  stripeCustomerId: string | null;

  @ApiPropertyOptional({
    description: 'Stripe subscription ID from Stripe API',
    example: 'sub_1234567890',
    nullable: true,
  })
  stripeSubscriptionId: string | null;

  @ApiPropertyOptional({
    description: 'Stripe price ID for the subscription plan',
    example: 'price_1234567890',
    nullable: true,
  })
  stripePriceId: string | null;

  @ApiProperty({
    description: 'Subscription creation timestamp',
    example: '2025-01-15T10:30:00.000Z',
    type: String,
    format: 'date-time',
  })
  createdAt: Date;

  @ApiProperty({
    description: 'Subscription last update timestamp',
    example: '2025-01-15T10:30:00.000Z',
    type: String,
    format: 'date-time',
  })
  updatedAt: Date;

  @ApiPropertyOptional({
    description: 'Soft deletion timestamp (null if not deleted)',
    example: null,
    type: String,
    format: 'date-time',
    nullable: true,
  })
  deletedAt: Date | null;
}
