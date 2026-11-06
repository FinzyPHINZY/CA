import { RefusalReason } from '@app/common';

const REFUSAL_TEMPLATES: Record<RefusalReason, string> = {
  [RefusalReason.LOW_CONFIDENCE]:
    "I couldn't find a clear answer to that in this script. Try rephrasing, or ask about a specific character or scene.",
  [RefusalReason.OFF_TOPIC]:
    'I can only answer questions about this script. Try asking about characters, scenes, themes, or specific lines.',
  [RefusalReason.EMBEDDINGS_NOT_READY]:
    'This script is still being indexed. Try again in about a minute.',
  [RefusalReason.RATE_LIMITED]:
    "You're sending questions too fast. Please wait a moment and try again.",
  [RefusalReason.QUOTA_EXCEEDED]:
    "You've reached your daily question limit. Try again tomorrow.",
};

export function getRefusalMessage(reason: RefusalReason): string {
  return REFUSAL_TEMPLATES[reason];
}
