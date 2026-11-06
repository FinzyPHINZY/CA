import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsString,
  IsDateString,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { SubscriptionPlan, SubscriptionStatus } from '@app/common';

export class CreateSubscriptionDto {
  @ApiProperty({
    description: 'User ID who owns this subscription',
    example: '8e2ebcd1-7138-48b6-bee8-b61ed03b4160',
    format: 'uuid',
  })
  @IsUUID()
  userId: string;

  @ApiProperty({
    description: 'Subscription plan type',
    enum: SubscriptionPlan,
    example: SubscriptionPlan.PREMIUM,
    enumName: 'SubscriptionPlan',
  })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiPropertyOptional({
    description: 'Subscription status. Defaults to ACTIVE if not provided.',
    enum: SubscriptionStatus,
    example: SubscriptionStatus.ACTIVE,
    enumName: 'SubscriptionStatus',
    default: SubscriptionStatus.ACTIVE,
  })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  status?: SubscriptionStatus;

  @ApiProperty({
    description: 'Subscription expiration date and time',
    example: '2025-02-15T10:30:00.000Z',
    type: String,
    format: 'date-time',
  })
  @IsDateString()
  expiresAt: string;

  @ApiPropertyOptional({
    description: 'Stripe customer ID associated with this subscription',
    example: 'cus_1234567890',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  stripeCustomerId?: string | null;

  @ApiPropertyOptional({
    description: 'Stripe subscription ID from Stripe API',
    example: 'sub_1234567890',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  stripeSubscriptionId?: string | null;

  @ApiPropertyOptional({
    description: 'Stripe price ID for the subscription plan',
    example: 'price_1234567890',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  stripePriceId?: string | null;
}
