// domain events for cross-service communication
// these events are published via RabbitMQ when significant domain actions occur.
// other services subscribe to these events to maintain data consistency.
// event naming convention: {entity}.{action}
// examples: user.deleted, user.updated, subscription.changed

// user events (published by auth_service)

// published when a user account is deleted (soft or hard delete)
// subscribers should cascade delete/anonymize all user-related data
export interface UserDeletedEvent {
  // event type identifier
  pattern: 'user.deleted';
  // user's unique identifier
  userId: string;
  // user's email (for logging/auditing)
  email: string;
  // iso timestamp of when the deletion occurred
  deletedAt: string;
  // whether this was a soft delete (can be restored) or hard delete
  isSoftDelete: boolean;
}

// published when user profile information is updated
// subscribers with denormalized user data should refresh their cache
export interface UserUpdatedEvent {
  // event type identifier
  pattern: 'user.updated';
  // user's unique identifier
  userId: string;
  // fields that were updated
  updatedFields: Array<'email' | 'fullName' | 'avatar' | 'roles' | 'timezone'>;
  // iso timestamp of when the update occurred
  updatedAt: string;
}

// published when a user's account is disabled/suspended
// subscribers may want to restrict access to user's resources
export interface UserDisabledEvent {
  pattern: 'user.disabled';
  userId: string;
  reason?: string;
  disabledAt: string;
}

// subscription events (published by billing service)

// published when a subscription status changes
export interface SubscriptionChangedEvent {
  pattern: 'subscription.changed';
  userId: string;
  previousPlan: string | null;
  newPlan: string;
  status: 'active' | 'cancelled' | 'expired' | 'past_due';
  changedAt: string;
}

// event patterns (for @EventPattern decorators)
export const EVENT_PATTERNS = {
  USER_DELETED: 'user.deleted',
  USER_UPDATED: 'user.updated',
  USER_DISABLED: 'user.disabled',
  SUBSCRIPTION_CHANGED: 'subscription.changed',
} as const;

// type helpers
export type DomainEvent =
  | UserDeletedEvent
  | UserUpdatedEvent
  | UserDisabledEvent
  | SubscriptionChangedEvent;

export type EventPattern = (typeof EVENT_PATTERNS)[keyof typeof EVENT_PATTERNS];
