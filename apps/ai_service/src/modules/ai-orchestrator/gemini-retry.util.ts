import { Logger } from '@nestjs/common';

const logger = new Logger('GeminiRetry');

const MAX_RETRIES = 5;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

/** HTTP status codes that warrant a retry. */
const RETRYABLE_STATUS_CODES = new Set([429, 503, 504]);

/** Error messages/codes that indicate transient failures. */
const RETRYABLE_ERROR_PATTERNS = [
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'socket hang up',
  'network',
  'timeout',
  'rate limit',
  'resource exhausted',
  'RESOURCE_EXHAUSTED',
  'overloaded',
  '503',
  '429',
];

function isRetryableError(error: any): boolean {
  // Check HTTP status code if present
  const status = error?.status ?? error?.response?.status ?? error?.code;
  if (typeof status === 'number' && RETRYABLE_STATUS_CODES.has(status)) {
    return true;
  }

  // Check error message patterns
  const message = (error?.message || error?.toString() || '').toLowerCase();
  return RETRYABLE_ERROR_PATTERNS.some((p) =>
    message.includes(p.toLowerCase()),
  );
}

function getRetryAfterMs(error: any): number | null {
  const retryAfter =
    error?.response?.headers?.['retry-after'] ??
    error?.headers?.['retry-after'];
  if (!retryAfter) return null;

  const seconds = Number(retryAfter);
  if (!isNaN(seconds) && seconds > 0) {
    return seconds * 1000;
  }
  return null;
}

function calculateDelay(attempt: number): number {
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 1000;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

/**
 * Wraps a Gemini API call with exponential backoff retry logic.
 *
 * - Retries on 429, 503, 504, and transient network errors
 * - Respects Retry-After header from 429 responses
 * - Adds jitter to prevent thundering herd
 * - Non-retryable errors (400, 401) throw immediately
 */
export async function withGeminiRetry<T>(
  fn: () => Promise<T>,
  label = 'gemini_call',
): Promise<T> {
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      if (attempt >= MAX_RETRIES || !isRetryableError(error)) {
        throw error;
      }

      const retryAfterMs = getRetryAfterMs(error);
      const delay = retryAfterMs ?? calculateDelay(attempt);

      logger.warn(
        `${label} attempt ${attempt + 1}/${MAX_RETRIES + 1} failed (retrying in ${Math.round(delay)}ms): ${error?.message || error}`,
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  throw lastError;
}
