// export enum UserRole {
//   ACTOR = 'actor',
//   SYSTEM_ADMIN = 'system_admin',
//   READER = 'reader',
// }

export enum MaterialType {
  FILE = 'file',
  LINK = 'link',
  TEXT = 'text',
}

export enum ScriptStatus {
  UPLOADED = 'UPLOADED',
  PROCESSING = 'PROCESSING',
  PARSING = 'PARSING',
  ANALYZING = 'ANALYZING',
  ANALYZED = 'ANALYZED',
  FAILED = 'FAILED',
}

export enum MediaType {
  VIDEO = 'VIDEO',
  AUDIO = 'AUDIO',
  IMAGE = 'IMAGE',
  DOCUMENT = 'DOCUMENT',
}

export enum SubscriptionPlan {
  FREE = 'FREE',
  STARTER = 'STARTER', // $9.99/month
  PREMIUM = 'PREMIUM', // $14.99/month
  ALL_ACCESS = 'ALL_ACCESS', // $19.99/month
}

export enum SubscriptionStatus {
  ACTIVE = 'ACTIVE',
  EXPIRED = 'EXPIRED',
  CANCELLED = 'CANCELLED',
}

export enum ProjectStatus {
  DRAFT = 'DRAFT',
  PENDING_ANALYSIS = 'PENDING_ANALYSIS',
  ACTIVE = 'ACTIVE',
  FAILED = 'FAILED',
}

export enum AnalysisOutboxStatus {
  PENDING = 'PENDING',
  PROCESSING = 'PROCESSING',
  DISPATCHED = 'DISPATCHED',
  FAILED = 'FAILED',
}

export enum ProjectAnalysisState {
  IDLE = 'IDLE',
  PROCESSING = 'PROCESSING',
  PARTIAL = 'PARTIAL',
  READY = 'READY',
}

export * from './day-of-week.enum';
export * from './marketplace.enum';
export * from './project-type.enum';
export * from './recording.enum';
export * from './rehearsal.enum';
export * from './user-role.enum';
