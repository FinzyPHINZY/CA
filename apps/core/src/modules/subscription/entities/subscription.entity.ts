import { BaseEntity, SubscriptionPlan, SubscriptionStatus } from '@app/common';
import { Column, Entity } from 'typeorm';

@Entity({ name: 'subscriptions', schema: 'billing_schema' })
export class Subscription extends BaseEntity {
  @Column()
  userId: string;

  @Column({ type: 'enum', enum: SubscriptionPlan })
  plan: SubscriptionPlan;

  @Column({ type: 'enum', enum: SubscriptionStatus })
  status: SubscriptionStatus;

  @Column()
  expiresAt: Date;

  @Column({ nullable: true })
  stripeCustomerId: string | null;

  @Column({ nullable: true })
  stripeSubscriptionId: string | null;

  @Column({ nullable: true })
  stripePriceId: string | null;
}
