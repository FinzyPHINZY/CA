export enum BookingStatus {
  PENDING_ACCEPTANCE = 'pending_acceptance',
  HELD = 'held',
  CONFIRMED = 'confirmed',
  IN_PROGRESS = 'in_progress',
  AWAITING_SETTLEMENT = 'awaiting_settlement',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  NO_SHOW = 'no_show',
}

export enum BookingType {
  SCHEDULED = 'scheduled',
  INSTANT = 'instant',
}

export enum OnboardingStatus {
  NOT_STARTED = 'not_started',
  IN_PROGRESS = 'in_progress',
  COMPLETED = 'completed',
}

export enum OnboardingStep {
  BIO = 'bio',
  SPECIALTIES = 'specialties',
  WORK_SAMPLES = 'work_samples',
  SESSION_RATES = 'session_rates',
  PAYMENT_SETUP = 'payment_setup',
  COMPLETED = 'completed',
}

export enum PaymentRecordStatus {
  PENDING = 'pending',
  SUCCEEDED = 'succeeded',
  SETTLED = 'settled',
  FAILED = 'failed',
  REFUNDED = 'refunded',
  PARTIALLY_REFUNDED = 'partially_refunded',
}

export enum ReaderGenre {
  DRAMA = 'drama',
  COMEDY = 'comedy',
  ROMANCE = 'romance',
  THRILLER = 'thriller',
  ACTION = 'action',
  FANTASY_SCI_FI = 'fantasy/sci-fi',
  HISTORICAL = 'historical',
  EXPERIMENTAL_INDIE = 'experimental/indie',
  MUSICAL_THEATRE = 'musical/theatre',
  DOCUMENTARY = 'documentary',
  OTHER = 'other',
}

export enum WorkSampleType {
  VIDEO = 'video',
  AUDIO = 'audio',
}

export enum ReaderWorkSampleSourceType {
  UPLOAD = 'upload',
  EXTERNAL_LINK = 'external_link',
}

export enum SocialPlatform {
  INSTAGRAM = 'instagram',
  YOUTUBE = 'youtube',
  TIKTOK = 'tiktok',
  TWITTER = 'twitter',
  LINKEDIN = 'linkedin',
  IMDB = 'imdb',
  WEBSITE = 'website',
  OTHER = 'other',
}

export enum CalendarProvider {
  GOOGLE = 'google',
  APPLE = 'apple',
  OUTLOOK = 'outlook',
}

export enum CancellationPolicy {
  FLEXIBLE = 'flexible', // Full refund > 24h, 50% 12-24h, none < 12h
  MODERATE = 'moderate', // Full refund > 48h, 50% 24-48h, none < 24h
  STRICT = 'strict', // Full refund > 7d, 50% 48h-7d, none < 48h
}

// Dispute window (hours) between session completion and reader payout.
// During this window, the booking sits in AWAITING_SETTLEMENT.
export const SETTLEMENT_DELAY_HOURS = 24;

export enum SessionExtensionStatus {
  REQUESTED = 'requested',
  APPROVED = 'approved',
  PAYMENT_PENDING = 'payment_pending',
  ACTIVE = 'active',
  DECLINED = 'declined',
  EXPIRED = 'expired',
  FAILED = 'failed',
}

export enum TimeSlotStatus {
  AVAILABLE = 'available',
  HELD = 'held',
  CONFIRMED = 'confirmed',
  COMPLETED = 'completed',
  CANCELLED = 'cancelled',
  // slot overlaps with an external calendar busy interval. Not bookable. Reverts to AVAILABLE when the external event is removed.
  BLOCKED = 'blocked',
}
