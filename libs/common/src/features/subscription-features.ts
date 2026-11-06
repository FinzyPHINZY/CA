import { SubscriptionPlan } from '../enums/enums';

/**
 * Feature flags for subscription-based access control
 */
export enum Feature {
  // Rehearsal Features
  REHEARSE_AI_VOICE = 'REHEARSE_AI_VOICE',
  REHEARSE_HUMAN_READER = 'REHEARSE_HUMAN_READER',
  REHEARSE_LIVE_READER = 'REHEARSE_LIVE_READER',

  // Recording Features
  SELF_TAPE_RECORDING = 'SELF_TAPE_RECORDING',
  SELF_TAPE_LIVE_READER = 'SELF_TAPE_LIVE_READER',
  SELF_TAPE_AI_VOICE = 'SELF_TAPE_AI_VOICE',

  // AI Features
  AI_SCENE_PARTNER = 'AI_SCENE_PARTNER',
  AI_VOICE_PLAYBACK = 'AI_VOICE_PLAYBACK',
  AI_SCRIPT_ANALYSIS = 'AI_SCRIPT_ANALYSIS',
  AI_CHARACTER_BREAKDOWNS = 'AI_CHARACTER_BREAKDOWNS',
  AI_GENERATED_SUMMARIES = 'AI_GENERATED_SUMMARIES',
  AI_COACHING = 'AI_COACHING',
  AI_PARTNER_FEEDBACK = 'AI_PARTNER_FEEDBACK',
  AI_VOICE_FEEDBACK = 'AI_VOICE_FEEDBACK',
  MULTI_VOICE_AI_PERFORMANCES = 'MULTI_VOICE_AI_PERFORMANCES',

  // Editing Features
  BASIC_TAPE_EDITING = 'BASIC_TAPE_EDITING',
  COLOR_CORRECTION = 'COLOR_CORRECTION',
  AUDIO_REPAIR = 'AUDIO_REPAIR',
  FULL_PRODUCTION_EDITING = 'FULL_PRODUCTION_EDITING',
  TITLE_CARDS = 'TITLE_CARDS',

  // Other Features
  TELEPROMPTER = 'TELEPROMPTER',
  TELEPROMPTER_ADVANCED = 'TELEPROMPTER_ADVANCED',
  WORD_PERFECT = 'WORD_PERFECT',
  RESUME_TEMPLATE_BUILDER = 'RESUME_TEMPLATE_BUILDER',
  SCENE_EXTRACT_TO_SCRIPT = 'SCENE_EXTRACT_TO_SCRIPT',
  EXPORT_REHEARSAL_CLIPS = 'EXPORT_REHEARSAL_CLIPS',
  WIDE_AI_VOICES = 'WIDE_AI_VOICES',
  MULTI_LANGUAGE_ACCENTS = 'MULTI_LANGUAGE_ACCENTS',
  SCRIPT_QA = 'SCRIPT_QA',
}

/**
 * Feature mapping by subscription plan
 * Higher plans inherit all features from lower plans
 */
const STARTER_FEATURES: Feature[] = [
  Feature.REHEARSE_AI_VOICE,
  Feature.REHEARSE_HUMAN_READER,
  Feature.SELF_TAPE_RECORDING,
  Feature.SELF_TAPE_LIVE_READER,
  Feature.SELF_TAPE_AI_VOICE,
];

const PREMIUM_FEATURES: Feature[] = [
  ...STARTER_FEATURES,
  Feature.AI_SCENE_PARTNER,
  Feature.AI_VOICE_PLAYBACK,
  Feature.AI_SCRIPT_ANALYSIS,
  Feature.AI_CHARACTER_BREAKDOWNS,
  Feature.AI_GENERATED_SUMMARIES,
  Feature.BASIC_TAPE_EDITING,
  Feature.TELEPROMPTER,
  Feature.SCRIPT_QA,
  // Note: Teleprompter advanced features NOT included in Premium
];

const ALL_ACCESS_FEATURES: Feature[] = [
  ...PREMIUM_FEATURES,
  Feature.REHEARSE_LIVE_READER,
  Feature.AI_PARTNER_FEEDBACK,
  Feature.AI_COACHING,
  Feature.AI_VOICE_FEEDBACK,
  Feature.MULTI_VOICE_AI_PERFORMANCES,
  Feature.COLOR_CORRECTION,
  Feature.AUDIO_REPAIR,
  Feature.FULL_PRODUCTION_EDITING,
  Feature.TITLE_CARDS,
  Feature.WORD_PERFECT,
  Feature.RESUME_TEMPLATE_BUILDER,
  Feature.SCENE_EXTRACT_TO_SCRIPT,
  Feature.EXPORT_REHEARSAL_CLIPS,
  Feature.WIDE_AI_VOICES,
  Feature.MULTI_LANGUAGE_ACCENTS,
  Feature.TELEPROMPTER_ADVANCED,
];

// Teleprompter Solo is free for all tiers during initial rollout.
// Tighten later by removing from FREE/STARTER once usage + Deepgram cost
// is understood. Premium and All-Access continue to inherit it.
const TELEPROMPTER_ROLLOUT_FREE_FEATURES: Feature[] = [Feature.TELEPROMPTER];

export const PLAN_FEATURES: Record<SubscriptionPlan, Feature[]> = {
  [SubscriptionPlan.FREE]: [...TELEPROMPTER_ROLLOUT_FREE_FEATURES],
  [SubscriptionPlan.STARTER]: [
    ...STARTER_FEATURES,
    ...TELEPROMPTER_ROLLOUT_FREE_FEATURES,
  ],
  [SubscriptionPlan.PREMIUM]: PREMIUM_FEATURES,
  [SubscriptionPlan.ALL_ACCESS]: ALL_ACCESS_FEATURES,
};

/**
 * Check if a subscription plan has access to a specific feature
 */
export function hasFeature(plan: SubscriptionPlan, feature: Feature): boolean {
  return PLAN_FEATURES[plan]?.includes(feature) ?? false;
}

/**
 * Get all features for a subscription plan
 */
export function getPlanFeatures(plan: SubscriptionPlan): Feature[] {
  return PLAN_FEATURES[plan] ?? [];
}
