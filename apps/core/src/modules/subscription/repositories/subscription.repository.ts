import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { Subscription } from '../entities/subscription.entity';
import { BaseRepository } from '@app/common';
import { SubscriptionPlan, SubscriptionStatus } from '@app/common';

@Injectable()
export class SubscriptionRepository extends BaseRepository<Subscription> {
  constructor(dataSource: DataSource) {
    super(Subscription, dataSource.manager);
  }

  /**
   * Find subscription by ID
   */
  async findById(id: string): Promise<Subscription | null> {
    return super.findById(id);
  }

  /**
   * Find subscription by ID or throw error
   */
  async findByIdOrFail(id: string): Promise<Subscription> {
    return super.findByIdOrFail(id);
  }

  /**
   * Find subscription by user ID (most recent)
   */
  async findByUserId(userId: string): Promise<Subscription | null> {
    const subscriptions = await this.findManyBy({ userId } as any, {
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return subscriptions[0] || null;
  }

  /**
   * Find all subscriptions by user ID
   */
  async findAllByUserId(userId: string): Promise<Subscription[]> {
    return this.findManyBy({ userId } as any, {
      order: { createdAt: 'DESC' },
    });
  }

  /**
   * Find subscriptions by status
   */
  async findByStatus(status: SubscriptionStatus): Promise<Subscription[]> {
    return this.findManyBy({ status } as any);
  }

  /**
   * Find subscriptions by plan
   */
  async findByPlan(plan: SubscriptionPlan): Promise<Subscription[]> {
    return this.findManyBy({ plan } as any);
  }

  /**
   * Create subscription
   */
  async createSubscription(
    subscriptionData: Partial<Subscription>,
  ): Promise<Subscription> {
    return this.createEntity({
      ...subscriptionData,
      status: subscriptionData.status || SubscriptionStatus.ACTIVE,
    });
  }

  /**
   * Update subscription
   */
  async updateSubscription(
    id: string,
    subscriptionData: Partial<Subscription>,
  ): Promise<Subscription | null> {
    return this.updateByIdAndReturn(id, subscriptionData);
  }

  /**
   * Cancel subscription
   */
  async cancelSubscription(id: string): Promise<Subscription | null> {
    return this.updateByIdAndReturn(id, {
      status: SubscriptionStatus.CANCELLED,
    } as any);
  }

  /**
   * Expire subscription
   */
  async expireSubscription(id: string): Promise<Subscription | null> {
    return this.updateByIdAndReturn(id, {
      status: SubscriptionStatus.EXPIRED,
    } as any);
  }

  /**
   * Delete subscription by ID
   */
  async deleteSubscription(id: string): Promise<void> {
    await this.hardDelete(id);
  }

  /**
   * Find subscription by Stripe customer ID
   */
  async findByStripeCustomerId(
    stripeCustomerId: string,
  ): Promise<Subscription | null> {
    const subscriptions = await this.findManyBy({ stripeCustomerId } as any, {
      order: { createdAt: 'DESC' },
      take: 1,
    });
    return subscriptions[0] || null;
  }

  /**
   * Find subscription by Stripe subscription ID
   */
  async findByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<Subscription | null> {
    return this.findOneBy({ stripeSubscriptionId } as any);
  }
}
