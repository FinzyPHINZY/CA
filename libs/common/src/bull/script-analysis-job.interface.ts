import { SubscriptionPlan } from '../enums/enums';

/**
 * Queue names used by the BullMQ script-analysis pipeline.
 */
export const SCRIPT_ANALYSIS_QUEUE = 'script-analysis';
export const SCRIPT_ANALYSIS_HEAVY_QUEUE = 'script-analysis-heavy';

/**
 * File-size threshold (bytes) that separates light from heavy jobs.
 * Scripts ≥ 5 MB are routed to the heavy queue with dedicated workers.
 */
export const HEAVY_FILE_SIZE_THRESHOLD = 5 * 1024 * 1024; // 5 MB

/**
 * Job data pushed into BullMQ by the core service (producer).
 * Consumed by ai_service workers.
 */
export interface ScriptAnalysisJobData {
  projectId: string;
  userId: string;
  mediaId: string;
  taskId: string;
  scriptId: string;
  scriptIndex?: number;
  /** The user's subscription plan at dispatch time — drives priority. */
  plan: SubscriptionPlan;
  /** Original file size in bytes — drives light/heavy routing. */
  fileSize: number;
}

/**
 * Map subscription plan → BullMQ priority (lower = higher priority).
 */
export function planToPriority(plan: SubscriptionPlan): number {
  switch (plan) {
    case SubscriptionPlan.ALL_ACCESS:
      return 1;
    case SubscriptionPlan.PREMIUM:
      return 3;
    case SubscriptionPlan.STARTER:
      return 5;
    case SubscriptionPlan.FREE:
    default:
      return 8;
  }
}
