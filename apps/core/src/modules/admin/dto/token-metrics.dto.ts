import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class TokenMetricsDto {
  @ApiProperty({
    description:
      'Total Gemini (LLM) tokens recorded in `billing_schema.usage_records` for service `gemini_tokens`, within the selected window (by row `createdAt`). One row is written per successful model completion in the AI service.',
    example: 1_250_000,
  })
  geminiTokenTotal: number;

  @ApiProperty({
    description:
      'Number of usage rows counted in the sum (same filter as `geminiTokenTotal`). Useful to see call volume vs token volume.',
    example: 24,
  })
  geminiUsageRecordCount: number;

  @ApiProperty({
    description:
      'Total ElevenLabs characters (`elevenlabs_characters`) in the selected window, same `createdAt` bounds as Gemini.',
    example: 48_000,
  })
  elevenLabsCharacterTotal: number;

  @ApiProperty({
    description:
      'Usage row count for `elevenlabs_characters` in the selected window.',
    example: 12,
  })
  elevenLabsUsageRecordCount: number;

  @ApiProperty({
    description:
      'Start of the comparison window immediately before the selected range, same duration as [from, to]. Non-overlapping: ends 1 ms before `from`.',
    example: '2026-04-24T00:00:00.000Z',
  })
  previousFrom: string;

  @ApiProperty({
    description:
      'End of the comparison window (inclusive), aligned with `previousFrom`.',
    example: '2026-04-30T23:59:59.999Z',
  })
  previousTo: string;

  @ApiProperty({
    description: 'Gemini token total in the comparison window.',
    example: 900_000,
  })
  geminiTokenPreviousTotal: number;

  @ApiProperty({
    description:
      '`geminiTokenTotal` minus `geminiTokenPreviousTotal` (can be negative).',
    example: 350_000,
  })
  geminiTokenDelta: number;

  @ApiProperty({
    description: 'Gemini usage row count in the comparison window.',
    example: 18,
  })
  geminiUsageRecordCountPrevious: number;

  @ApiProperty({
    description:
      '`geminiUsageRecordCount` minus `geminiUsageRecordCountPrevious`.',
    example: 6,
  })
  geminiUsageRecordCountDelta: number;

  @ApiProperty({
    description: 'ElevenLabs character total in the comparison window.',
    example: 30_000,
  })
  elevenLabsCharacterPreviousTotal: number;

  @ApiProperty({
    description:
      '`elevenLabsCharacterTotal` minus `elevenLabsCharacterPreviousTotal`.',
    example: 18_000,
  })
  elevenLabsCharacterDelta: number;

  @ApiProperty({
    description: 'ElevenLabs usage row count in the comparison window.',
    example: 8,
  })
  elevenLabsUsageRecordCountPrevious: number;

  @ApiProperty({
    description:
      '`elevenLabsUsageRecordCount` minus `elevenLabsUsageRecordCountPrevious`.',
    example: 4,
  })
  elevenLabsUsageRecordCountDelta: number;

  @ApiPropertyOptional({
    description:
      'Estimated Gemini spend in USD for the selected window when `ADMIN_METRICS_GEMINI_USD_PER_MILLION_TOKENS` is set (tokens ÷ 1e6 × rate). Otherwise null.',
    example: 12.5,
    nullable: true,
  })
  geminiEstimatedCostUsd: number | null;

  @ApiPropertyOptional({
    description: 'Same rate applied to `geminiTokenPreviousTotal`.',
    nullable: true,
  })
  geminiEstimatedCostPreviousUsd: number | null;

  @ApiPropertyOptional({
    description:
      '`geminiEstimatedCostUsd` minus `geminiEstimatedCostPreviousUsd` when both are non-null; otherwise null.',
    nullable: true,
  })
  geminiEstimatedCostDeltaUsd: number | null;

  @ApiPropertyOptional({
    description:
      'Estimated ElevenLabs spend in USD when `ADMIN_METRICS_ELEVENLABS_USD_PER_MILLION_CHARS` is set (characters ÷ 1e6 × rate). Otherwise null.',
    nullable: true,
  })
  elevenLabsEstimatedCostUsd: number | null;

  @ApiPropertyOptional({
    description: 'Same rate applied to `elevenLabsCharacterPreviousTotal`.',
    nullable: true,
  })
  elevenLabsEstimatedCostPreviousUsd: number | null;

  @ApiPropertyOptional({
    description:
      '`elevenLabsEstimatedCostUsd` minus `elevenLabsEstimatedCostPreviousUsd` when both are non-null; otherwise null.',
    nullable: true,
  })
  elevenLabsEstimatedCostDeltaUsd: number | null;

  @ApiPropertyOptional({
    description:
      'Sum of non-null Gemini and ElevenLabs USD estimates for the current window. Null when both components are null.',
    nullable: true,
  })
  totalEstimatedCostUsd: number | null;

  @ApiPropertyOptional({
    description: 'Sum of non-null previous-window USD estimates.',
    nullable: true,
  })
  totalEstimatedCostPreviousUsd: number | null;

  @ApiPropertyOptional({
    description:
      '`totalEstimatedCostUsd` minus `totalEstimatedCostPreviousUsd` when both are non-null; otherwise null.',
    nullable: true,
  })
  totalEstimatedCostDeltaUsd: number | null;

  @ApiProperty({
    description: 'Resolved start of the metrics window (inclusive).',
    example: '2026-05-01T00:00:00.000Z',
  })
  from: string;

  @ApiProperty({
    description: 'Resolved end of the metrics window (inclusive).',
    example: '2026-05-06T23:59:59.999Z',
  })
  to: string;
}
