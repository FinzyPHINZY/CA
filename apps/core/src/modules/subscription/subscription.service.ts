import { Injectable, NotFoundException } from '@nestjs/common';
import { Subscription } from './entities/subscription.entity';
import { SubscriptionRepository } from './repositories/subscription.repository';
import { SubscriptionStatus } from '@app/common';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly subscriptionRepository: SubscriptionRepository,
  ) {}

  async findById(id: string): Promise<any> {
    const subscription = await this.subscriptionRepository.findById(id);
    if (!subscription) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Subscription retrieved successfully',
      data: subscription,
    };
  }

  async findByUserId(userId: string): Promise<any> {
    const subscription = await this.subscriptionRepository.findByUserId(userId);
    return {
      success: true,
      message: 'Subscription retrieved successfully',
      data: subscription,
    };
  }

  async create(subscriptionData: Partial<Subscription>): Promise<any> {
    const subscription =
      await this.subscriptionRepository.createSubscription(subscriptionData);
    return {
      success: true,
      message: 'Subscription created successfully',
      data: subscription,
    };
  }

  async update(
    id: string,
    subscriptionData: Partial<Subscription>,
  ): Promise<any> {
    const updated = await this.subscriptionRepository.updateSubscription(
      id,
      subscriptionData,
    );
    if (!updated) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Subscription updated successfully',
      data: updated,
    };
  }

  async cancel(id: string): Promise<any> {
    const cancelled = await this.subscriptionRepository.cancelSubscription(id);
    if (!cancelled) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return {
      success: true,
      message: 'Subscription cancelled successfully',
      data: cancelled,
    };
  }

  async expire(id: string): Promise<Subscription> {
    const expired = await this.subscriptionRepository.expireSubscription(id);
    if (!expired) {
      throw new NotFoundException(`Subscription with ID ${id} not found`);
    }
    return expired;
  }

  async findByStripeSubscriptionId(
    stripeSubscriptionId: string,
  ): Promise<Subscription | null> {
    return this.subscriptionRepository.findByStripeSubscriptionId(
      stripeSubscriptionId,
    );
  }
}
