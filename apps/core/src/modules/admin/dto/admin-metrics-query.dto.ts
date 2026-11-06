import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional } from 'class-validator';

export class AdminMetricsQueryDto {
  @ApiPropertyOptional({
    description:
      'Start of the reporting window (inclusive, ISO 8601). Defaults to 7 days before now when omitted.',
    example: '2026-05-01T00:00:00.000Z',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({
    description:
      'End of the reporting window (inclusive, ISO 8601). Defaults to now when omitted.',
    example: '2026-05-06T23:59:59.999Z',
  })
  @IsOptional()
  @IsDateString()
  to?: string;
}
