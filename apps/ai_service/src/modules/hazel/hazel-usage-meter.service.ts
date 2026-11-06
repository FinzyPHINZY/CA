// HazelUsageMeterService
// Records ElevenLabs character and Deepgram minute usage on session end.
// Pre-session quota check before accepting a prepare request.

import { UsageRecordRepository, UsageService } from '@app/common';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import type { Turn } from './types/hazel.types';

// tier limits (placeholder — will be driven by subscription tier in production)
const DEFAULT_ELEVENLABS_CHAR_LIMIT = 500_000; // per billing period
const DEFAULT_DEEPGRAM_MINUTE_LIMIT = 600; // per billing period

@Injectable()
export class HazelUsageMeterService {
  private readonly logger = new Logger(HazelUsageMeterService.name);

  constructor(private readonly usageRecordRepository: UsageRecordRepository) {}

  // record usage after a session ends.
  async recordSessionUsage(
    userId: string,
    rehearsalId: string,
    turns: Turn[],
    sessionStartedAt: Date,
    sessionEndedAt: Date,
    totalPausedMs: number,
  ): Promise<void> {
    const { start: periodStart, end: periodEnd } = this.currentBillingPeriod();

    // elevenLabs characters: sum of all hazel line text lengths
    const elevenLabsChars = turns
      .filter((t) => t.type === 'hazel')
      .reduce((sum, t) => sum + t.text.length, 0);

    // deepgram minutes: active speaking time (session duration - paused) / 60000 rounded up
    const activeMs =
      sessionEndedAt.getTime() - sessionStartedAt.getTime() - totalPausedMs;
    const deepgramMinutes = Math.ceil(activeMs / 60_000);

    await Promise.all([
      this.usageRecordRepository.save({
        userId,
        service: UsageService.ELEVENLABS_CHARACTERS,
        quantity: elevenLabsChars,
        unit: 'characters',
        rehearsalId,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      } as any),
      this.usageRecordRepository.save({
        userId,
        service: UsageService.DEEPGRAM_MINUTES,
        quantity: deepgramMinutes,
        unit: 'minutes',
        rehearsalId,
        billingPeriodStart: periodStart,
        billingPeriodEnd: periodEnd,
      } as any),
    ]);

    this.logger.log(
      `Usage recorded for ${rehearsalId}: ElevenLabs=${elevenLabsChars}ch, Deepgram=${deepgramMinutes}min`,
    );
  }

  // pre-session quota check — reject before starting prep if over limit
  async checkQuota(
    userId: string,
    turns: Turn[],
    estimatedSessionMinutes: number,
  ): Promise<void> {
    const { start: periodStart, end: periodEnd } = this.currentBillingPeriod();

    const [currentChars, currentMinutes] = await Promise.all([
      this.usageRecordRepository.sumUsageForPeriod(
        userId,
        UsageService.ELEVENLABS_CHARACTERS,
        periodStart,
        periodEnd,
      ),
      this.usageRecordRepository.sumUsageForPeriod(
        userId,
        UsageService.DEEPGRAM_MINUTES,
        periodStart,
        periodEnd,
      ),
    ]);

    const projectedChars = turns
      .filter((t) => t.type === 'hazel')
      .reduce((sum, t) => sum + t.text.length, 0);

    if (currentChars + projectedChars > DEFAULT_ELEVENLABS_CHAR_LIMIT) {
      throw new BadRequestException({
        error: 'QUOTA_EXCEEDED',
        service: 'elevenlabs_characters',
        periodUsed: currentChars,
        projectedSession: projectedChars,
        tierLimit: DEFAULT_ELEVENLABS_CHAR_LIMIT,
      });
    }

    if (
      currentMinutes + estimatedSessionMinutes >
      DEFAULT_DEEPGRAM_MINUTE_LIMIT
    ) {
      throw new BadRequestException({
        error: 'QUOTA_EXCEEDED',
        service: 'deepgram_minutes',
        periodUsed: currentMinutes,
        projectedSession: estimatedSessionMinutes,
        tierLimit: DEFAULT_DEEPGRAM_MINUTE_LIMIT,
      });
    }
  }

  private currentBillingPeriod(): { start: Date; end: Date } {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
    return { start, end };
  }
}
