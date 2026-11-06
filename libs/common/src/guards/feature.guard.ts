/** biome-ignore-all lint/style/useImportType: <> */
import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SubscriptionPlan } from '../enums/enums';
import { Feature, hasFeature } from '../features/subscription-features';

export const FEATURE_KEY = 'feature';
export const RequireFeature = (feature: Feature) =>
  SetMetadata(FEATURE_KEY, feature);

@Injectable()
export class FeatureGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredFeature = this.reflector.getAllAndOverride<Feature>(
      FEATURE_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!requiredFeature) {
      // No feature requirement, allow access
      return true;
    }

    const request = context.switchToHttp().getRequest();
    const user = request.user;

    if (!user) {
      throw new ForbiddenException('User not authenticated');
    }

    // Get user's subscription plan
    // Note: You'll need to inject SubscriptionService and fetch the subscription
    // For now, this is a placeholder - you'll need to implement the actual lookup
    const userPlan = user.subscriptionPlan || SubscriptionPlan.FREE;

    if (!hasFeature(userPlan, requiredFeature)) {
      throw new ForbiddenException(
        `Feature ${requiredFeature} is not available in your subscription plan. Please upgrade to access this feature.`,
      );
    }

    return true;
  }
}
