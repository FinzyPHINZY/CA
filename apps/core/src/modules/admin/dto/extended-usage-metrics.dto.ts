import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ExtendedUsageMetricsDto {
  @ApiProperty({
    description:
      'Deepgram minutes (`deepgram_minutes`) in the selected window.',
    example: 120.5,
  })
  deepgramMinutesTotal: number;

  @ApiProperty({ description: 'Usage row count for Deepgram in the window.' })
  deepgramUsageRecordCount: number;

  @ApiProperty({
    description: 'Agora minutes (`agora_minutes`) in the selected window.',
    example: 45,
  })
  agoraMinutesTotal: number;

  @ApiProperty({ description: 'Usage row count for Agora in the window.' })
  agoraUsageRecordCount: number;

  @ApiProperty({
    description:
      'S3 storage bytes (`s3_storage_bytes`) summed in the selected window.',
    example: 1_073_741_824,
  })
  s3StorageBytesTotal: number;

  @ApiProperty({ description: 'Usage row count for S3 storage in the window.' })
  s3StorageUsageRecordCount: number;

  @ApiProperty({ description: 'Deepgram minutes in the comparison window.' })
  deepgramMinutesPreviousTotal: number;

  @ApiProperty({
    description: 'Delta vs comparison window for Deepgram minutes.',
  })
  deepgramMinutesDelta: number;

  @ApiProperty({ description: 'Agora minutes in the comparison window.' })
  agoraMinutesPreviousTotal: number;

  @ApiProperty({ description: 'Delta vs comparison window for Agora minutes.' })
  agoraMinutesDelta: number;

  @ApiProperty({ description: 'S3 bytes in the comparison window.' })
  s3StorageBytesPreviousTotal: number;

  @ApiProperty({ description: 'Delta vs comparison window for S3 bytes.' })
  s3StorageBytesDelta: number;

  @ApiPropertyOptional({
    description:
      'Estimated Deepgram USD when `ADMIN_METRICS_DEEPGRAM_USD_PER_MINUTE` is set.',
    nullable: true,
  })
  deepgramEstimatedCostUsd: number | null;

  @ApiPropertyOptional({
    description:
      'Estimated Agora USD when `ADMIN_METRICS_AGORA_USD_PER_MINUTE` is set.',
    nullable: true,
  })
  agoraEstimatedCostUsd: number | null;

  @ApiProperty({
    description: 'Resolved start of the metrics window (inclusive).',
  })
  from: string;

  @ApiProperty({
    description: 'Resolved end of the metrics window (inclusive).',
  })
  to: string;

  @ApiProperty({ description: 'Comparison window start (inclusive).' })
  previousFrom: string;

  @ApiProperty({ description: 'Comparison window end (inclusive).' })
  previousTo: string;
}
